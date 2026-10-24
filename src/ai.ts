// AI CORE

import chalk from 'chalk';
import loki from 'lokijs';
import type * as Misskey from 'misskey-js';
import { createRequire } from 'module';
import APIClient, { type ApiParam, type PostParam } from '@/api/APIClient.js';
import config from '@/config.js';
import DatabaseManager from '@/database/DatabaseManager.js';
import { bindThis } from '@/decorators.js';
import Friend from '@/friend.js';
import Message, { type ChatMessage } from '@/message.js';
import type { Note } from '@/misskey/note.js';
import type { User } from '@/misskey/user.js';
import Module from '@/module.js';
import { ReactionService } from '@/services/reaction.js';
import { RelationshipService } from '@/services/relationship.js';
import Stream from '@/stream.js';
import TimerManager from '@/timer/TimerManager.js';
import log from '@/utils/log.js';
import { sleep } from './utils/sleep.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** chatUser チャンネルから届くメッセージ。fromUser は省略されてくる。 */
type ChatStreamMessage = Omit<ChatMessage, 'fromUser'> & { fromUser?: User };

export type MentionHook = (msg: Message) => Promise<boolean | HandlerResult>;
// data は永続化層経由のため内容はモジュール側が知る。境界では unknown とする。
export type ContextHook = (
  key: string | null,
  msg: Message,
  data?: unknown
) => Promise<void | boolean | HandlerResult>;
export type TimeoutCallback = (data?: unknown) => void | Promise<void>;

export type HandlerResult = {
  reaction?: string | null;
  immediate?: boolean;
};

export type InstallerResult = {
  mentionHook?: MentionHook;
  contextHook?: ContextHook;
  timeoutCallback?: TimeoutCallback;
};

export type Meta = {
  lastWakingAt: number;
  /** memory.json のスキーマ版。起動時のマイグレーション判定に使う。 */
  schemaVersion?: number;
};

type RegisteredMentionHook = {
  module: string;
  handler: MentionHook;
};

/**
 * 藍
 */
export default class 藍 {
  public readonly version = pkg._v;
  public account: User;
  public connection!: Stream;
  public modules: Module[] = [];
  private mentionHooks: RegisteredMentionHook[] = [];
  private contextHooks: { [moduleName: string]: ContextHook } = {};
  private timeoutCallbacks: { [moduleName: string]: TimeoutCallback } = {};
  private dbManager!: DatabaseManager;
  private apiClient!: APIClient;
  private timerManager!: TimerManager;
  private intervals: NodeJS.Timeout[] = [];
  private stopping = false;
  public lastSleepedAt!: number;

  /** フォロー関係・マスター判定 */
  public readonly relationship: RelationshipService;
  /** リアクション作成 */
  public readonly reactions: ReactionService;

  /** データベースのリポジトリ */
  public get repos() {
    return this.dbManager.repositories;
  }

  /**
   * データベースの統計情報を取得します
   */
  @bindThis
  public getDatabaseStats() {
    const collections = this.dbManager.db.collections?.filter(Boolean) || [];
    let totalDocuments = 0;
    let totalSize = 0;

    for (const collection of collections) {
      totalDocuments += collection.count();
      totalSize += JSON.stringify(collection.data).length;
    }

    return {
      collections: collections.length,
      documents: totalDocuments,
      size: totalSize,
    };
  }

  /**
   * 藍インスタンスを生成します
   * @param account 藍として使うアカウント
   * @param modules モジュール。先頭のモジュールほど高優先度
   */
  constructor(account: User, modules: Module[]) {
    this.account = account;
    this.modules = modules;

    this.log('Initializing DatabaseManager...');
    this.apiClient = new APIClient();
    this.relationship = new RelationshipService(
      this.apiClient,
      account.id,
      config.master
    );
    this.reactions = new ReactionService(this.apiClient, (friend) =>
      this.shouldReaction(friend)
    );

    this.dbManager = new DatabaseManager(
      () => {
        this.log(chalk.green('The memory loaded successfully'));
        this.timerManager = new TimerManager(
          this.dbManager,
          this.timeoutCallbacks
        );
        this.run();
      },
      (err) => {
        this.log(chalk.red(`Failed to load the memory: ${err}`));
      }
    );
  }

  @bindThis
  public log(msg: string) {
    log(`[${chalk.magenta('AiOS')}]: ${msg}`);
  }

  @bindThis
  private run() {
    if (this.stopping) return;

    // データベース初期化はDatabaseManagerで自動実行
    const meta = this.dbManager.getMeta();
    this.lastSleepedAt = meta.lastWakingAt;

    // Init stream
    this.connection = new Stream();

    // start heartbeat
    this.intervals.push(setInterval(this.connection.heartbeat, 1000 * 60));

    //#region Main stream
    const mainStream = this.connection.useSharedConnection('main');

    // メンションされたとき
    mainStream.on('mention', (data) => {
      void this.handleIncomingNote(data, { requireMention: true }).catch(
        (err) => this.log(`mention handler failed: ${String(err)}`)
      );
    });

    // 返信されたとき
    mainStream.on('reply', (data) => {
      void this.handleIncomingNote(data, { requireMention: false }).catch(
        (err) => this.log(`reply handler failed: ${String(err)}`)
      );
    });

    // Renoteされたとき
    mainStream.on('renote', (data) => {
      void this.handleRenote(data).catch((err) =>
        this.log(`renote handler failed: ${String(err)}`)
      );
    });

    // 通知
    mainStream.on('notification', (data) => {
      this.onNotification(data);
    });

    // チャット
    mainStream.on('newChatMessage', (data) => {
      void this.handleChatMessage(data).catch((err) =>
        this.log(`chat handler failed: ${String(err)}`)
      );
    });
    //#endregion

    // Install modules
    for (const m of this.modules) {
      this.log(`Installing ${chalk.cyan.italic(m.name)}\tmodule...`);
      m.init(this);

      try {
        const res = m.getHooks();
        if (res.mentionHook) {
          this.mentionHooks.push({
            module: m.name,
            handler: res.mentionHook,
          });
        }
        if (res.contextHook) this.contextHooks[m.name] = res.contextHook;
        if (res.timeoutCallback) {
          this.timeoutCallbacks[m.name] = res.timeoutCallback;
        }
      } catch (err) {
        this.log(
          chalk.red(`Failed to install module "${m.name}": ${String(err)}`)
        );
      }
    }

    // TimerManagerにコールバックを更新
    this.timerManager.updateTimeoutCallbacks(this.timeoutCallbacks);

    // タイマー監視開始
    this.timerManager.startMonitoring();

    // 稼働記録。以前は10秒ごとだったが、Lokiのautosaveで
    // memory.json 全体を書き出す頻度が高すぎるため5分に延ばす。
    this.intervals.push(setInterval(this.logWaking, 5 * 60_000));

    this.log(chalk.green.bold('Ai am now running!'));
  }

  /**
   * メンション/リプライのストリームイベントを処理する。
   */
  private async handleIncomingNote(
    raw: Note,
    options: { requireMention: boolean }
  ): Promise<void> {
    if (raw.userId == this.account.id) return; // 自分は弾く

    let data = raw;
    // Misskeyのバグで投稿が非公開扱いになることがあるため、textが無ければ取得する
    if (data.text == null) {
      data = await this.api<Note>('notes/show', { noteId: data.id });
    }

    const text: string | null = data.text ?? null;

    if (options.requireMention) {
      if (text == null) return;
      if (!text.startsWith(`@${this.account.username}`)) return;
    } else {
      // メンションは mention イベントで処理するので、reply では二重処理しない
      if (text != null && text.startsWith(`@${this.account.username}`)) return;
    }

    await this.onReceiveMessage(new Message(this, data, false));
  }

  private async handleRenote(data: Note): Promise<void> {
    if (data.userId == this.account.id) return; // 自分は弾く
    if (data.text == null && (data.files || []).length == 0) return;

    const friend = this.lookupFriend(data.userId);
    await this.reactions.react(data.id, 'love', friend);
  }

  private async handleChatMessage(data: ChatMessage): Promise<void> {
    const fromUser = data.fromUser;
    if (data.fromUserId == this.account.id) return; // 自分は弾く
    await this.onReceiveMessage(new Message(this, data, true));

    // 一定期間 chatUser のストリームに接続して今後のやり取りに備える
    if (!data.fromUserId) return;

    const chatStream = this.connection.connectToChannel('chatUser', {
      otherId: data.fromUserId,
    });

    let timer: NodeJS.Timeout | undefined;
    const setTimer = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(
        () => {
          chatStream.dispose();
        },
        1000 * 60 * 2
      );
    };
    setTimer();

    chatStream.on('message', (message: ChatStreamMessage) => {
      if (message.fromUserId == this.account.id) return; // 自分は弾く
      chatStream.send('read', { id: message.id });
      void this.onReceiveMessage(
        new Message(
          this,
          {
            ...message,
            // fromUserは省略されてくるため
            fromUser,
          },
          true
        )
      ).catch((err) => this.log(`chat message failed: ${String(err)}`));
      setTimer();
    });
  }

  /**
   * ユーザーから話しかけられたとき
   * (メンション、リプライ、トークのメッセージ)
   */
  @bindThis
  private async onReceiveMessage(msg: Message): Promise<void> {
    this.log(chalk.gray(`<<< An message received: ${chalk.underline(msg.id)}`));

    // Ignore message if the user is a bot
    // To avoid infinity reply loop.
    if (msg.user.isBot) {
      return;
    }

    const isNoContext = !msg.isChat && msg.replyId == null;

    // Look up the context
    const context = isNoContext
      ? null
      : msg.isChat
        ? this.repos.contexts.findForChat(msg.userId)
        : this.repos.contexts.findForNote(msg.replyId);

    let reaction: string | null = 'love';
    let immediate = false;

    const applyResult = (res: void | boolean | HandlerResult): void => {
      if (res != null && typeof res === 'object') {
        if (res.reaction !== undefined) reaction = res.reaction;
        if (res.immediate != null) immediate = res.immediate;
      }
    };

    // コンテキストがあればコンテキストフック呼び出し
    // なければそれぞれのモジュールについてフックが引っかかるまで呼び出し
    let handled = false;

    if (context != null) {
      const handler = this.contextHooks[context.module];

      if (handler == null) {
        this.log(
          chalk.yellow(
            `Context module "${context.module}" is not installed; falling back to mention hooks`
          )
        );
        // 無効化されたモジュールのコンテキストが残っている場合は掃除する
        this.repos.contexts.remove(context);
      } else {
        try {
          const res = await handler(context.key, msg, context.data);
          applyResult(res);
          handled = res !== false;
        } catch (err) {
          this.log(
            chalk.red(
              `Context hook of "${context.module}" failed: ${String(err)}`
            )
          );
          handled = false;
        }
      }
    }

    if (!handled) {
      let res: boolean | HandlerResult | null = null;

      for (const { module, handler } of this.mentionHooks) {
        try {
          res = await handler(msg);
        } catch (err) {
          this.log(
            chalk.red(`Mention hook of "${module}" failed: ${String(err)}`)
          );
          res = false;
          continue;
        }

        if (res === true || typeof res === 'object') break;
      }

      if (res != null) applyResult(res);
    }

    if (!immediate) {
      await sleep(1000);
    }

    // リアクションする（チャットは対象外）
    if (!msg.isChat) {
      await this.reactions.react(msg.id, reaction, msg.friend);
    }
  }

  @bindThis
  private onNotification(notification: Misskey.entities.Notification) {
    switch (notification.type) {
      // リアクションされたら親愛度を少し上げる
      // TODO: リアクション取り消しをよしなにハンドリングする
      case 'reaction': {
        const friend = new Friend(this, { user: notification.user });
        friend.incLove(0.1);
        break;
      }

      default:
        break;
    }
  }

  @bindThis
  private logWaking() {
    if (this.stopping) return;
    this.setMeta({
      lastWakingAt: Date.now(),
    });
  }

  /**
   * データベースのコレクションを取得します
   */
  @bindThis
  public getCollection<T extends object = any>(
    name: string,
    opts?: { indices?: (keyof T)[] }
  ): loki.Collection<T> {
    return this.dbManager.getCollection<T>(name, opts);
  }

  @bindThis
  public lookupFriend(userId: User['id']): Friend | null {
    const doc = this.repos.friends.findById(userId);

    if (doc == null) return null;

    return new Friend(this, { doc: doc });
  }

  /**
   * リアクション設定を確認します
   */
  @bindThis
  public shouldReaction(friend: Friend | null): boolean {
    if (!friend) return true; // friendが存在しない場合はデフォルトで有効

    const reactionModule = this.modules.find(
      (m) => m.name === 'reaction-config'
    ) as unknown as { isReactionEnabled(friend: Friend): boolean } | undefined;

    return reactionModule ? reactionModule.isReactionEnabled(friend) : true;
  }

  /**
   * ファイルをドライブにアップロードします
   */
  @bindThis
  public async upload(
    file: Buffer,
    meta: { filename: string; contentType: string }
  ) {
    return this.apiClient.upload(file, meta);
  }

  /**
   * 投稿します
   */
  @bindThis
  public async post(param: PostParam): Promise<Note> {
    return this.apiClient.post(param);
  }

  /**
   * 指定ユーザーにチャットメッセージを送信します
   */
  @bindThis
  public sendMessage(userId: string, param: ApiParam) {
    return this.apiClient.sendMessage(userId, param);
  }

  /**
   * APIを呼び出します
   */
  @bindThis
  public api<T>(endpoint: string, param?: ApiParam): Promise<T> {
    return this.apiClient.api<T>(endpoint, param);
  }

  /**
   * コンテキストを生成し、ユーザーからの返信を待ち受けます
   * @param module 待ち受けるモジュール名
   * @param key コンテキストを識別するためのキー
   * @param isChat チャット上のコンテキストかどうか
   * @param id チャット上のコンテキストならばチャット相手のID、そうでないなら待ち受ける投稿のID
   * @param data コンテキストに保存するオプションのデータ
   */
  @bindThis
  public subscribeReply(
    module: Module,
    key: string | null,
    isChat: boolean,
    id: string,
    data?: unknown
  ) {
    this.repos.contexts.subscribe(
      isChat
        ? {
            isChat: true,
            userId: id,
            module: module.name,
            key: key,
            data: data,
          }
        : {
            isChat: false,
            noteId: id,
            module: module.name,
            key: key,
            data: data,
          }
    );
  }

  /**
   * 返信の待ち受けを解除します
   * @param module 解除するモジュール名
   * @param key コンテキストを識別するためのキー
   */
  @bindThis
  public unsubscribeReply(module: Module, key: string | null) {
    this.repos.contexts.removeByKey(module.name, key);
  }

  /**
   * 指定したミリ秒経過後に、そのモジュールのタイムアウトコールバックを呼び出します。
   * このタイマーは記憶に永続化されるので、途中でプロセスを再起動しても有効です。
   */
  @bindThis
  public setTimeoutWithPersistence(
    module: Module,
    delay: number,
    data?: unknown
  ) {
    return this.timerManager.setTimeoutWithPersistence(module, delay, data);
  }

  @bindThis
  public getMeta() {
    return this.dbManager.getMeta();
  }

  @bindThis
  public setMeta(meta: Partial<Meta>) {
    return this.dbManager.setMeta(meta);
  }

  /**
   * 実行中の処理を止め、DBを保存して終了する。
   */
  @bindThis
  public async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.log('Stopping AiOS...');

    for (const id of this.intervals) clearInterval(id);
    this.intervals = [];

    for (const module of this.modules) {
      try {
        module.dispose();
      } catch (err) {
        this.log(`Failed to dispose module "${module.name}": ${String(err)}`);
      }
    }

    this.timerManager?.stopMonitoring();

    try {
      this.connection?.close();
    } catch (err) {
      this.log(`Failed to close stream: ${String(err)}`);
    }

    this.dbManager.close();
    this.log(chalk.green('AiOS stopped'));
  }
}
