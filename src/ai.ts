// AI CORE

import * as fs from 'fs';
import { bindThis } from '@/decorators.js';
import got from 'got';
import { FormData, File } from 'formdata-node';
import chalk from 'chalk';
import { v4 as uuid } from 'uuid';

import config from '@/config.js';
import Module from '@/module.js';
import Message from '@/message.js';
import Friend, { FriendDoc } from '@/friend.js';
import type { User } from '@/misskey/user.js';
import Stream from '@/stream.js';
import log from '@/utils/log.js';
import { sleep } from './utils/sleep.js';
import DatabaseManager from '@/database/DatabaseManager.js';
import APIClient from '@/api/APIClient.js';
import TimerManager from '@/timer/TimerManager.js';
// import pkg from '../package.json' assert { type: 'json' };
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const pkg = require('../package.json');

type MentionHook = (msg: Message) => Promise<boolean | HandlerResult>;
type ContextHook = (
  key: any,
  msg: Message,
  data?: any
) => Promise<void | boolean | HandlerResult>;
type TimeoutCallback = (data?: any) => void;

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
};

/**
 * 藍
 */
export default class 藍 {
  public readonly version = pkg._v;
  public account: User;
  public connection!: Stream;
  public modules: Module[] = [];
  private mentionHooks: MentionHook[] = [];
  private contextHooks: { [moduleName: string]: ContextHook } = {};
  private timeoutCallbacks: { [moduleName: string]: TimeoutCallback } = {};
  private dbManager!: DatabaseManager;
  private apiClient!: APIClient;
  private timerManager!: TimerManager;
  public lastSleepedAt!: number;

  // DatabaseManagerからのアクセサー
  public get db() {
    return this.dbManager.db;
  }
  public get friends() {
    return this.dbManager.friends;
  }
  public get moduleData() {
    return this.dbManager.moduleData;
  }
  private get contexts() {
    return this.dbManager.contexts;
  }

  /**
   * データベースの統計情報を取得します
   */
  @bindThis
  public getDatabaseStats() {
    return this.dbManager.getStats();
  }

  /**
   * データベースをバックアップします
   */
  @bindThis
  public backupDatabase(backupPath?: string) {
    return this.dbManager.backup(backupPath);
  }

  /**
   * データベースを最適化します
   */
  @bindThis
  public optimizeDatabase() {
    this.dbManager.vacuum();
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

    this.dbManager = new DatabaseManager(
      () => {
        this.log(chalk.green('The memory loaded successfully'));
        // TimerManagerを初期化
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
    // データベース初期化はDatabaseManagerで自動実行
    const meta = this.dbManager.getMeta();
    this.lastSleepedAt = meta.lastWakingAt;

    // Init stream
    this.connection = new Stream();

    // start heartbeat
    setInterval(this.connection.heartbeat, 1000 * 60);

    //#region Main stream
    const mainStream = this.connection.useSharedConnection('main');

    // メンションされたとき
    mainStream.on('mention', async (data) => {
      if (data.userId == this.account.id) return; // 自分は弾く
      if (data.text && data.text.startsWith('@' + this.account.username)) {
        // Misskeyのバグで投稿が非公開扱いになる
        if (data.text == null)
          data = await this.api('notes/show', { noteId: data.id });
        this.onReceiveMessage(new Message(this, data, false));
      }
    });

    // 返信されたとき
    mainStream.on('reply', async (data) => {
      if (data.userId == this.account.id) return; // 自分は弾く
      if (data.text && data.text.startsWith('@' + this.account.username))
        return;
      // Misskeyのバグで投稿が非公開扱いになる
      if (data.text == null)
        data = await this.api('notes/show', { noteId: data.id });
      this.onReceiveMessage(new Message(this, data, false));
    });

    // Renoteされたとき
    mainStream.on('renote', async (data) => {
      if (data.userId == this.account.id) return; // 自分は弾く
      if (data.text == null && (data.files || []).length == 0) return;

      // リアクション設定チェック
      const friend = this.lookupFriend(data.userId);
      if (!this.shouldReaction(friend)) return;

      // リアクションする
      this.api('notes/reactions/create', {
        noteId: data.id,
        reaction: 'love',
      });
    });

    // 通知
    mainStream.on('notification', (data) => {
      this.onNotification(data);
    });

    // チャット
    mainStream.on('newChatMessage', (data) => {
      const fromUser = data.fromUser;
      if (data.fromUserId == this.account.id) return; // 自分は弾く
      this.onReceiveMessage(new Message(this, data, true));

      // 一定期間 chatUser / chatRoom のストリームに接続して今後のやり取りに備える
      if (data.fromUserId) {
        const chatStream = this.connection.connectToChannel('chatUser', {
          otherId: data.fromUserId,
        });

        let timer;
        function setTimer() {
          if (timer) clearTimeout(timer);
          timer = setTimeout(
            () => {
              chatStream.dispose();
            },
            1000 * 60 * 2
          );
        }
        setTimer();

        chatStream.on('message', (data) => {
          if (data.fromUserId == this.account.id) return; // 自分は弾く
          chatStream.send('read', {
            id: data.id,
          });
          this.onReceiveMessage(
            new Message(
              this,
              {
                ...data,
                // fromUserは省略されてくるため
                fromUser: fromUser,
              },
              true
            )
          );
          setTimer();
        });
      } else {
        // TODO: room
      }
    });
    //#endregion

    // Install modules
    this.modules.forEach((m) => {
      this.log(`Installing ${chalk.cyan.italic(m.name)}\tmodule...`);
      m.init(this);
      const res = m.install();
      if (res != null) {
        if (res.mentionHook) this.mentionHooks.push(res.mentionHook);
        if (res.contextHook) this.contextHooks[m.name] = res.contextHook;
        if (res.timeoutCallback)
          this.timeoutCallbacks[m.name] = res.timeoutCallback;
      }
    });

    // TimerManagerにコールバックを更新
    this.timerManager.updateTimeoutCallbacks(this.timeoutCallbacks);

    // タイマー監視開始
    this.timerManager.startMonitoring();

    setInterval(this.logWaking, 10000);

    this.log(chalk.green.bold('Ai am now running!'));
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
      : this.contexts.findOne(
          msg.isChat
            ? {
                isChat: true,
                userId: msg.userId,
              }
            : {
                isChat: false,
                noteId: msg.replyId === null ? undefined : msg.replyId, // Handle null replyId
              }
        );

    let reaction: string | null = 'love';
    let immediate: boolean = false;

    //#region
    const invokeMentionHooks = async () => {
      let res: boolean | HandlerResult | null = null;

      for (const handler of this.mentionHooks) {
        res = await handler(msg);
        if (res === true || typeof res === 'object') break;
      }

      if (res != null && typeof res === 'object') {
        if (res.reaction != null) reaction = res.reaction;
        if (res.immediate != null) immediate = res.immediate;
      }
    };

    // コンテキストがあればコンテキストフック呼び出し
    // なければそれぞれのモジュールについてフックが引っかかるまで呼び出し
    if (context != null) {
      const handler = this.contextHooks[context.module];
      const res = await handler(context.key, msg, context.data);

      if (res != null && typeof res === 'object') {
        if (res.reaction != null) reaction = res.reaction;
        if (res.immediate != null) immediate = res.immediate;
      }

      if (res === false) {
        await invokeMentionHooks();
      }
    } else {
      await invokeMentionHooks();
    }
    //#endregion

    if (!immediate) {
      await sleep(1000);
    }

    // リアクションする
    if (msg.isChat) {
      // TODO: リアクション？
    } else {
      // リアクションする
      if (reaction && this.shouldReaction(msg.friend)) {
        this.api('notes/reactions/create', {
          noteId: msg.id,
          reaction: reaction,
        });
      }
    }
  }

  @bindThis
  private onNotification(notification: any) {
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
    this.setMeta({
      lastWakingAt: Date.now(),
    });
  }

  /**
   * コレクションを取得
   */
  @bindThis
  public getCollection(name: string, opts?: any): any {
    return this.dbManager.getCollection(name, opts);
  }

  @bindThis
  public lookupFriend(userId: User['id']): Friend | null {
    const doc = this.friends.findOne({
      userId: userId,
    });

    if (doc == null) return null;

    const friend = new Friend(this, { doc: doc });

    return friend;
  }

  /**
   * リアクション設定を確認します
   */
  @bindThis
  public shouldReaction(friend: Friend | null): boolean {
    if (!friend) return true; // friendが存在しない場合はデフォルトで有効

    const reactionModule = this.modules.find(
      (m) => m.name === 'reaction-config'
    ) as any;

    return reactionModule ? reactionModule.isReactionEnabled(friend) : true;
  }

  /**
   * ファイルをドライブにアップロードします
   */
  @bindThis
  public async upload(
    file: Buffer | fs.ReadStream,
    meta: { filename: string; contentType: string }
  ) {
    return this.apiClient.upload(file, meta);
  }

  /**
   * 投稿します
   */
  @bindThis
  public async post(param: any): Promise<any> {
    return this.apiClient.post(param);
  }

  /**
   * 指定ユーザーにチャットメッセージを送信します
   */
  @bindThis
  public sendMessage(userId: any, param: any) {
    return this.apiClient.sendMessage(userId, param);
  }

  /**
   * APIを呼び出します
   */
  @bindThis
  public api<T>(endpoint: string, param?: any): Promise<T> {
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
    data?: any
  ) {
    this.contexts.insertOne(
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
    this.contexts.findAndRemove({
      key: key,
      module: module.name,
    });
  }

  /**
   * 指定したミリ秒経過後に、そのモジュールのタイムアウトコールバックを呼び出します。
   * このタイマーは記憶に永続化されるので、途中でプロセスを再起動しても有効です。
   * @param module モジュール名
   * @param delay ミリ秒
   * @param data オプションのデータ
   */
  @bindThis
  public setTimeoutWithPersistence(module: Module, delay: number, data?: any) {
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
   * AIを停止します
   */
  @bindThis
  public shutdown() {
    this.log('Shutting down...');
    
    // タイマー監視を停止
    if (this.timerManager) {
      this.timerManager.stopMonitoring();
    }
    
    // データベースを閉じる
    if (this.dbManager) {
      this.dbManager.close();
    }
    
    this.log('Shutdown complete');
  }
}
