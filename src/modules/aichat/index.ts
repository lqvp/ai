import { randomUUID } from 'node:crypto';
import path from 'node:path';
import type * as Misskey from 'misskey-js';
import type { HandlerResult } from '@/ai.js';
import config from '@/config/index.js';
import { bindThis } from '@/decorators.js';
import type Message from '@/message.js';
import type { Note } from '@/misskey/types.js';
import Module from '@/module.js';
import { fetchNoteFiles } from '@/services/media.js';
import type Stream from '@/stream.js';
import {
  AffinityStore,
  formatAffinityPromptContext,
} from './affinity-store.js';
import { postAutoNote } from './auto-note.js';
import { ChatHandler } from './chat-handler.js';
import {
  DEFAULTS,
  HOURS_TO_MS,
  MINUTES_TO_MS,
  TIMEOUT_TIME,
  TYPE_GEMINI,
} from './constants.js';
import { EmojiCatalog, type EmojiCatalogItem } from './emoji-catalog.js';
import {
  type AiChatHist,
  ChatHistoryRepository,
} from './history-repository.js';
import { auditInteraction } from './interaction-auditor.js';
import { PlaybookLoader } from './playbook.js';
import { ReactionFollowUpHandler } from './reaction-followup.js';
import { resolveProvider } from './structured-llm.js';
import { TextGenerator } from './text-generator.js';
import type { AiChat, Base64File } from './types.js';
import {
  collectUrlInfo,
  formatTimelineContext,
  isYoutubeUrl,
} from './url-context.js';
import { WanderRunner } from './wander.js';
import { WanderStore } from './wander-store.js';

const RESTRICTED_VISIBILITIES = new Set(['specified', 'followers']);
const WANDER_TICK_MS = 5 * MINUTES_TO_MS;
const SESSION_SWEEP_INTERVAL_MS = 60_000;

export default class extends Module {
  public readonly name = 'aichat';
  private history!: ChatHistoryRepository;
  private generator!: TextGenerator;
  private chatHandler!: ChatHandler;
  private playbookLoader!: PlaybookLoader;
  private affinityStore!: AffinityStore;
  private emojiCatalog!: EmojiCatalog;
  private wanderStore!: WanderStore;
  private wanderRunner!: WanderRunner;
  private reactionFollowUp!: ReactionFollowUpHandler;
  private mainStream?: ReturnType<Stream['useSharedConnection']>;

  /** この生成ラウンドでLLMツールがリアクションを付けたノートIDと記録時刻 */
  private toolReactedNoteIds = new Map<string, number>();
  /** セッション単位の並行ターン直列化 */
  private sessionLocks = new Map<string, Promise<void>>();
  /** 同一ノートの重複到着ガード */
  private inFlightNoteIds = new Set<string>();

  @bindThis
  public install() {
    this.history = new ChatHistoryRepository(
      this.ai.getCollection('aichatHist', {
        indices: ['sessionId', 'postId', 'originalNoteId', 'chatUserId'],
      })
    );

    const isEnabled =
      config.aichat?.enabled ??
      Boolean(
        config.gemini?.enabled || config.aiProvider?.provider === 'openai'
      );
    if (!isEnabled) {
      this.log('aichat機能が無効になっています');
      return false;
    }

    this.warnLegacyConfigIfPresent();

    const memoryDir = path.resolve(config.memoryDir || '.');
    const playbookPath = config.aichat?.playbookPath
      ? path.resolve(config.aichat.playbookPath)
      : path.join(memoryDir, 'PLAYBOOK.md');

    this.playbookLoader = new PlaybookLoader({
      filePath: playbookPath,
      aiName: config.aiName?.[0] || this.ai.account.name || '藍',
      master: config.master || 'admin',
      log: (m) => this.log(m),
    });
    void this.playbookLoader.ensureSeeded();

    this.affinityStore = new AffinityStore({
      filePath: path.join(memoryDir, 'aichat-affinity.json'),
      ignoreThreshold: config.aichat?.affinity?.ignoreThreshold ?? -30,
      decayIdleDays: config.aichat?.affinity?.decayIdleDays ?? 7,
      decayIntervalDays: config.aichat?.affinity?.decayIntervalDays ?? 3,
      log: (m) => this.log(m),
    });

    this.emojiCatalog = new EmojiCatalog({
      cacheFilePath: path.join(memoryDir, 'aichat-emojis-cache.json'),
      cacheTtlHours: config.aichat?.emojis?.cacheTtlHours ?? 6,
      nsfwCategories: config.aichat?.emojis?.nsfwCategories,
      fetchEmojis: async () => {
        const res = await this.ai.api<{ emojis?: EmojiCatalogItem[] }>(
          'emojis',
          {}
        );
        return res?.emojis ?? [];
      },
      log: (m) => this.log(m),
    });

    this.wanderStore = new WanderStore({
      filePath: path.join(memoryDir, 'aichat-wander.json'),
      log: (m) => this.log(m),
    });

    this.generator = new TextGenerator({
      log: (message) => this.log(message),
      isMasterUser: (msg) => this.isMasterUser(msg),
      isYoutubeUrl,
      collectUrlInfo: (aiChat) => collectUrlInfo(aiChat, (m) => this.log(m)),
      formatTimelineContext,
      getMisskeyTools: () => {
        const toolsConfig = config.aichat?.misskeyTools;
        if (toolsConfig?.enabled === false) return null;
        return {
          api: async (endpoint: string, param?: Record<string, unknown>) => {
            const result = await this.ai.api(endpoint, param);
            if (
              endpoint === 'notes/reactions/create' &&
              typeof param?.noteId === 'string'
            ) {
              this.toolReactedNoteIds.set(param.noteId, Date.now());
            }
            return result;
          },
          allowReaction: toolsConfig?.allowReaction !== false,
        };
      },
    });

    this.chatHandler = new ChatHandler({
      ai: this.ai,
      moduleName: this.name,
      history: this.history,
      log: (message) => this.log(message),
      genTextDetailed: (aiChat, files, msg) =>
        this.genTextDetailed(aiChat, files, msg),
      subscribeReply: (key, isChat, id, data) =>
        this.subscribeReply(key, isChat, id, data),
      removeOldNoteContext: (noteId) =>
        this.ai.repos.contexts.removeByNoteId(this.name, noteId),
      later: (ms, task) => this.later(ms, task),
      buildPlaybookText: () => this.playbookLoader.load(),
      buildAffinityContext: async (user, isMaster) => {
        if (config.aichat?.affinity?.enabled === false) return '';
        const friend = this.ai.lookupFriend(user.id);
        const entry = await this.affinityStore.getEntry(user, {
          isMaster,
          initialLoveSeed: friend?.love,
        });
        return formatAffinityPromptContext(entry, {
          isMaster,
          ignoreThreshold: config.aichat?.affinity?.ignoreThreshold ?? -30,
        });
      },
    });

    this.wanderRunner = new WanderRunner({
      api: (endpoint, param) => this.ai.api(endpoint, param),
      post: (param) => this.ai.post(param),
      react: (noteId, reaction, friend) =>
        this.ai.reactions.react(noteId, reaction, friend),
      lookupFriend: (userId) => this.ai.lookupFriend(userId),
      isFollowing: (userId) => this.isFollowing(userId),
      isMasterUser: (user) => this.ai.relationship.isMaster(user),
      hasExistingConversationInChain: async (noteId) => {
        const inChildren = await this.findExistingHistoryInChain(
          noteId,
          'notes/children'
        );
        if (inChildren) return true;
        const inConv = await this.findExistingHistoryInChain(
          noteId,
          'notes/conversation'
        );
        return inConv != null;
      },
      affinityStore: this.affinityStore,
      emojiCatalog: this.emojiCatalog,
      playbookLoader: this.playbookLoader,
      wanderStore: this.wanderStore,
      history: this.history,
      subscribeReply: (key, isChat, noteId, data) =>
        this.subscribeReply(key, isChat, noteId, data),
      selfUserId: this.ai.account.id,
      postNotPublic: config.postNotPublic,
      config: {
        timelines: config.aichat?.wander?.timelines,
        followingOnly: config.aichat?.wander?.followingOnly,
        activeHoursStart: config.aichat?.wander?.activeHours?.start,
        activeHoursEnd: config.aichat?.wander?.activeHours?.end,
        minGapMinutes: config.aichat?.wander?.minGapMinutes,
        postCooldownMinutes: config.aichat?.wander?.postCooldownMinutes,
        maxReactionsPerRun: config.aichat?.wander?.maxReactionsPerRun,
        replyProbability: config.aichat?.wander?.replyProbability,
        postProbability: config.aichat?.wander?.postProbability,
        replyMaxAgeMinutes: config.aichat?.wander?.replyMaxAgeMinutes,
        reactionMaxAgeMinutes: config.aichat?.wander?.reactionMaxAgeMinutes,
        userReplyCooldownMinutes:
          config.aichat?.wander?.userReplyCooldownMinutes,
        userReactionCooldownMinutes:
          config.aichat?.wander?.userReactionCooldownMinutes,
        appendHashtag: config.aichat?.wander?.appendHashtag,
      },
      log: (m) => this.log(m),
    });

    this.reactionFollowUp = new ReactionFollowUpHandler({
      selfUserId: this.ai.account.id,
      history: this.history,
      affinityStore: this.affinityStore,
      playbookLoader: this.playbookLoader,
      isMasterUser: (user) => this.ai.relationship.isMaster(user),
      post: (param) => this.ai.post(param),
      subscribeReply: (key, isChat, noteId, data) =>
        this.subscribeReply(key, isChat, noteId, data),
      postNotPublic: config.postNotPublic,
      config: config.aichat?.reactionFollowUp,
      log: (m) => this.log(m),
    });

    // セッションTTLと起動時孤立コンテキストの掃除
    this.sweepOrphanContexts();
    this.every(SESSION_SWEEP_INTERVAL_MS, this.sweepExpiredSessions, {
      immediate: true,
    });

    // ランダム時刻 TL 巡回 / レガシー autoNote の排他制御
    const wanderEnabled =
      config.aichat?.wander?.enabled ??
      Boolean(config.gemini?.randomTalk?.enabled);

    if (wanderEnabled) {
      if (config.gemini?.autoNote?.enabled) {
        this.log(
          '[aichat.wander] が有効なため、レガシーの [gemini.autoNote] は抑制されます'
        );
      }
      this.every(WANDER_TICK_MS, () => this.wanderRunner.runTick());
      this.log('ランダム時刻 TL 巡回(wander)を有効化: tick=5m');
    } else if (config.gemini?.autoNote?.enabled) {
      const autoNoteConfig = config.gemini.autoNote;
      const interval =
        autoNoteConfig.intervalMinutes !== undefined &&
        !Number.isNaN(autoNoteConfig.intervalMinutes)
          ? autoNoteConfig.intervalMinutes * MINUTES_TO_MS
          : DEFAULTS.AUTO_NOTE_INTERVAL_HOURS * HOURS_TO_MS;
      this.every(
        interval +
          Math.random() *
            ((DEFAULTS.AUTO_NOTE_INTERVAL_HOURS * HOURS_TO_MS) / 20),
        this.autoNote
      );
      this.log(`レガシー自動ノート投稿を有効化: interval=${interval}ms`);
    }

    // リアクション通知受信（好感度微増＋条件付き追いリプ）
    this.mainStream = this.ai.connection.useSharedConnection('main');
    this.mainStream.on('notification', this.onNotification);

    return {
      mentionHook: this.mentionHook,
      fallbackMentionHook: this.fallbackMentionHook,
      contextHook: this.contextHook,
      timeoutCallback: this.timeoutCallback,
    };
  }

  protected onDispose(): void {
    this.mainStream?.dispose();
    this.mainStream = undefined;
    this.reactionFollowUp?.dispose();
  }

  private warnLegacyConfigIfPresent(): void {
    const rawAichat = config.aichat as Record<string, unknown> | undefined;
    if (!rawAichat) return;
    const legacyKeys = [
      'episodeMemory',
      'moodEngine',
      'tlDiary',
      'proactiveFollowup',
    ].filter((key) => rawAichat[key] !== undefined);
    if (legacyKeys.length > 0) {
      this.log(
        `非推奨の旧設定 (${legacyKeys.join(', ')}) が config.toml に残っています。新設計(PLAYBOOK.md / aichat-affinity.json / aichat.wander)では無視されます。`
      );
    }
  }

  @bindThis
  private onNotification(notification: Misskey.entities.Notification): void {
    if (notification.type !== 'reaction') return;
    void this.reactionFollowUp.handleNotification(notification).catch((err) => {
      this.log(
        `リアクション通知処理エラー: ${err instanceof Error ? err.message : String(err)}`
      );
    });
  }

  @bindThis
  private sweepOrphanContexts(): void {
    const contexts = this.ai.repos.contexts.findByModule(this.name);
    let cleaned = 0;
    for (const ctx of contexts) {
      const dataSessionId = (ctx.data as { sessionId?: string } | undefined)
        ?.sessionId;
      const sessionId = dataSessionId ?? ctx.key;
      const hasSession =
        (sessionId != null &&
          this.history.findBySessionId(sessionId) != null) ||
        (ctx.isChat &&
          ctx.userId != null &&
          this.history.findChat(ctx.userId) != null) ||
        (!ctx.isChat &&
          ctx.noteId != null &&
          this.history.findByPostId(ctx.noteId) != null);
      if (!hasSession) {
        this.ai.repos.contexts.remove(ctx);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      this.log(`孤立したコンテキスト ${cleaned} 件を掃除しました`);
    }
  }

  @bindThis
  private sweepExpiredSessions(): void {
    const expired = this.history.findExpired(Date.now());
    for (const doc of expired) {
      const key = doc.sessionId ?? doc.postId;
      this.unsubscribeReply(key);
      if (doc.postIds) {
        for (const id of doc.postIds) {
          this.ai.repos.contexts.removeByNoteId(this.name, id);
        }
      }
      this.history.remove(doc);
    }
  }

  @bindThis
  private getProvider(): 'gemini' | 'openai' {
    return resolveProvider();
  }

  @bindThis
  private async genTextDetailed(
    aiChat: AiChat,
    files: Base64File[],
    msg?: Message
  ) {
    const now = Date.now();
    for (const [id, ts] of this.toolReactedNoteIds) {
      if (now - ts > 3_600_000) this.toolReactedNoteIds.delete(id);
    }
    return this.generator.genTextDetailed(
      this.getProvider(),
      aiChat,
      files,
      msg
    );
  }

  @bindThis
  private isFollowing(userId: string): Promise<boolean> {
    return this.ai.relationship.isFollowing(userId);
  }

  @bindThis
  private isMasterUser(msg: Message): boolean {
    return this.ai.relationship.isMaster(msg.user);
  }

  private async runWithSessionLock<T>(
    lockKey: string,
    task: () => Promise<T>
  ): Promise<T> {
    const prev = this.sessionLocks.get(lockKey) ?? Promise.resolve();
    let release!: () => void;
    const nextLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const chain = prev.then(
      () => nextLock,
      () => nextLock
    );
    this.sessionLocks.set(lockKey, chain);
    await prev.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.sessionLocks.get(lockKey) === chain) {
        this.sessionLocks.delete(lockKey);
      }
    }
  }

  private async checkPreLlmIgnore(msg: Message): Promise<boolean> {
    if (config.aichat?.affinity?.enabled === false) return false;
    const isMaster = this.isMasterUser(msg);
    if (isMaster) return false;
    const friend = this.ai.lookupFriend(msg.userId);
    const entry = await this.affinityStore.getEntry(msg.user, {
      isMaster: false,
      initialLoveSeed: friend?.love,
    });
    return this.affinityStore.getTier(entry.score, false) === 'ignore';
  }

  private async auditAndUpdateAffinity(
    msg: Message,
    userText: string,
    isMaster: boolean,
    turnSeq: number,
    options: { allowReaction: boolean }
  ): Promise<string | null> {
    const friend = this.ai.lookupFriend(msg.userId);
    const entry = await this.affinityStore.getEntry(msg.user, {
      isMaster,
      initialLoveSeed: friend?.love,
    });

    const isRemote = msg.user.host != null;
    const palette = options.allowReaction
      ? await this.emojiCatalog.selectPalette(userText, {
          isRemoteNote: isRemote,
          maxCount: 25,
        })
      : [];

    const audit = await auditInteraction({
      userText,
      currentNote: entry.notes,
      currentScore: entry.score,
      isMaster,
      emojiPalette: palette,
      allowNoteUpdate: config.aichat?.affinity?.enabled !== false,
      allowReaction: options.allowReaction,
      log: (m) => this.log(m),
    });

    if (config.aichat?.affinity?.enabled !== false) {
      await this.affinityStore.applyInteractionUpdate({
        user: msg.user,
        isMaster,
        delta: audit.delta,
        note: audit.note,
        userText,
        source: 'chat',
        turnSeq,
        initialLoveSeed: friend?.love,
      });
    }

    if (!options.allowReaction) return null;
    return this.emojiCatalog.validateReaction(audit.reaction, {
      isRemoteNote: isRemote,
      fallback: 'like',
    });
  }

  private async runStep2Audit(
    msg: Message,
    userText: string,
    isMaster: boolean,
    turnSeq: number,
    options: { react: boolean }
  ): Promise<string | null> {
    try {
      const allowReaction =
        options.react && !msg.isChat && !this.toolReactedNoteIds.has(msg.id);

      const validated = await this.auditAndUpdateAffinity(
        msg,
        userText,
        isMaster,
        turnSeq,
        { allowReaction }
      );
      if (!allowReaction || !validated) return null;

      const reacted = await this.ai.reactions.react(
        msg.id,
        validated,
        msg.friend
      );
      if (!reacted && validated.startsWith(':')) {
        await this.ai.reactions.react(msg.id, 'like', msg.friend);
        return 'like';
      }
      return validated;
    } catch (err: unknown) {
      this.log(
        `Step2監査処理エラー: ${err instanceof Error ? err.message : String(err)}`
      );
      return null;
    }
  }

  private async executeChatTurn(
    targetHist: AiChatHist,
    msg: Message
  ): Promise<HandlerResult> {
    const turnSeq = this.affinityStore.issueTurnSeq(msg.user);
    const result = await this.chatHandler.handle(targetHist, msg);

    if (result.status === 'failed') {
      return { reaction: null, immediate: true };
    }

    if (result.status === 'ignored') {
      void this.runStep2Audit(msg, result.userText, result.isMaster, turnSeq, {
        react: false,
      });
      return { reaction: null, immediate: true };
    }

    if (result.status === 'react_only') {
      if (msg.isChat) {
        void this.runStep2Audit(
          msg,
          result.userText,
          result.isMaster,
          turnSeq,
          {
            react: false,
          }
        );
        return { reaction: null, immediate: true };
      }

      // react_only の場合のみ Step 2 を使ってリアクション1つを選び、ai.ts へ委譲する
      try {
        const validated = await this.auditAndUpdateAffinity(
          msg,
          result.userText,
          result.isMaster,
          turnSeq,
          { allowReaction: !this.toolReactedNoteIds.has(msg.id) }
        );
        return { reaction: validated ?? 'like' };
      } catch (err: unknown) {
        this.log(
          `Step2(react_only)監査エラー: ${err instanceof Error ? err.message : String(err)}`
        );
        return { reaction: 'like' };
      }
    }

    // 通常返信: ai.ts 側のデフォルト 'love' を抑止し、Step 2 が非同期でリアクションする
    void this.runStep2Audit(msg, result.userText, result.isMaster, turnSeq, {
      react: !msg.isChat,
    });
    return { reaction: null, immediate: true };
  }

  private async startNewConversation(
    msg: Message,
    options: { isFallbackMention: boolean }
  ): Promise<boolean | HandlerResult> {
    if (this.inFlightNoteIds.has(msg.id)) {
      return { reaction: null, immediate: true };
    }
    this.inFlightNoteIds.add(msg.id);

    try {
      const requireFollowing = config.aichat?.followingOnly !== false;
      if (
        requireFollowing &&
        !this.isMasterUser(msg) &&
        !(await this.isFollowing(msg.userId))
      ) {
        this.log('The user is not following me: ' + msg.userId);
        if (!options.isFallbackMention) {
          await msg
            .reply('あなたはaichatを実行する権限がありません。')
            .catch(() => {});
        }
        return { reaction: null, immediate: true };
      }

      if (await this.checkPreLlmIgnore(msg)) {
        this.log(`好感度しきい値以下のため応答をスキップ: ${msg.userId}`);
        return { reaction: null, immediate: true };
      }

      const sessionKey = msg.isChat ? `chat:${msg.userId}` : `note:${msg.id}`;
      return await this.runWithSessionLock(sessionKey, async () => {
        if (msg.isChat) {
          const exist = this.history.findChat(msg.userId);
          if (exist != null) {
            return await this.executeChatTurn(exist, msg);
          }
        } else {
          const exist = await this.findExistingHistoryInChain(
            msg.id,
            'notes/conversation'
          );
          if (exist != null) return false;
        }

        const nowMs = Date.now();
        const current: AiChatHist = {
          sessionId: msg.isChat ? `chat:${msg.userId}` : randomUUID(),
          postId: msg.id,
          createdAt: nowMs,
          updatedAt: nowMs,
          expiresAt: nowMs + TIMEOUT_TIME,
          type: TYPE_GEMINI,
          fromMention: true,
          isFallbackMention: options.isFallbackMention,
          isChat: msg.isChat,
          chatUserId: msg.isChat ? msg.userId : undefined,
          ownerUserId: msg.userId,
        };

        if (msg.quoteId) {
          try {
            const quotedNote = await this.ai.api<
              Partial<{ text: string; visibility: string }>
            >('notes/show', {
              noteId: msg.quoteId,
            });
            if (
              quotedNote.visibility &&
              RESTRICTED_VISIBILITIES.has(quotedNote.visibility)
            ) {
              this.log(
                `限定公開の引用元ノート(${msg.quoteId})は情報漏えい防止のためスキップします`
              );
            } else {
              if (quotedNote.text) {
                current.history = [
                  {
                    role: 'user',
                    content:
                      'ユーザーが与えた前情報である、引用された文章: ' +
                      quotedNote.text,
                  },
                ];
              }
              current.quotedFiles = await fetchNoteFiles(
                this.ai.api,
                msg.quoteId,
                {
                  includeUrl: true,
                  log: (m) => this.log(m),
                }
              );
            }
          } catch (err: unknown) {
            this.log(
              `引用元ノートの取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        return await this.executeChatTurn(current, msg);
      });
    } finally {
      this.inFlightNoteIds.delete(msg.id);
    }
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.includes([this.name])) {
      return false;
    }
    this.log('AiChat requested');
    return this.startNewConversation(msg, { isFallbackMention: false });
  }

  @bindThis
  private async fallbackMentionHook(msg: Message) {
    if (config.aichat?.respondToAllMentions !== true) {
      return false;
    }
    this.log('AiChat fallback mention requested');
    return this.startNewConversation(msg, { isFallbackMention: true });
  }

  @bindThis
  private async contextHook(key: string | null, msg: Message, data?: unknown) {
    this.log('contextHook...');
    if (this.inFlightNoteIds.has(msg.id)) {
      return { reaction: null, immediate: true };
    }
    this.inFlightNoteIds.add(msg.id);

    try {
      const ctxData = (data ?? {}) as {
        sessionId?: string;
        historyLength?: number;
      };
      const sessionId = ctxData.sessionId ?? key ?? undefined;

      // チャットモードで終了コマンドが送られた場合
      if (
        msg.isChat &&
        msg.text != null &&
        (msg.includes(['aichat 終了']) ||
          msg.includes(['aichat 終わり']) ||
          msg.includes(['aichat やめる']) ||
          msg.includes(['aichat 止めて']))
      ) {
        const exist =
          (sessionId ? this.history.findBySessionId(sessionId) : null) ??
          this.history.findChat(msg.userId);
        if (exist != null) {
          this.history.remove(exist);
          if (key != null) this.unsubscribeReply(key);
          if (exist.sessionId && exist.sessionId !== key) {
            this.unsubscribeReply(exist.sessionId);
          }
          await msg
            .reply(
              '藍チャットを終了しました。また何かあればお声がけくださいね！'
            )
            .catch(() => {});
          return { reaction: 'like' };
        }
      }

      const lockKey = sessionId ?? (msg.isChat ? `chat:${msg.userId}` : msg.id);
      return await this.runWithSessionLock(lockKey, async () => {
        let exist: AiChatHist | null = sessionId
          ? this.history.findBySessionId(sessionId)
          : null;

        if (!exist) {
          exist = msg.isChat
            ? this.history.findChat(msg.userId)
            : msg.replyId
              ? this.history.findByPostId(msg.replyId)
              : null;
        }

        if (exist == null) {
          this.log('conversation context is not found; cleaning up.');
          if (key != null) this.unsubscribeReply(key);
          return false;
        }

        const nowMs = Date.now();
        const expiresAt = exist.expiresAt ?? exist.createdAt + TIMEOUT_TIME;
        if (nowMs >= expiresAt) {
          this.log('conversation context expired; cleaning up.');
          if (key != null) this.unsubscribeReply(key);
          if (exist.sessionId && exist.sessionId !== key) {
            this.unsubscribeReply(exist.sessionId);
          }
          this.history.remove(exist);
          return false;
        }

        const isBotInitiatedOwner =
          !exist.fromMention && exist.ownerUserId === msg.userId;
        const requireFollowing = config.aichat?.followingOnly !== false;
        if (
          requireFollowing &&
          !this.isMasterUser(msg) &&
          !isBotInitiatedOwner &&
          !(await this.isFollowing(msg.userId))
        ) {
          this.log('The user is not following me: ' + msg.userId);
          await msg
            .reply('あなたはaichatを実行する権限がありません。')
            .catch(() => {});
          return { reaction: null, immediate: true };
        }

        if (await this.checkPreLlmIgnore(msg)) {
          if (key != null) this.unsubscribeReply(key);
          if (exist.sessionId && exist.sessionId !== key) {
            this.unsubscribeReply(exist.sessionId);
          }
          this.history.remove(exist);
          return { reaction: null, immediate: true };
        }

        // ノート上で別ユーザーから分岐返信、または古いターンへ分岐返信が来た場合は新セッションへ分岐する
        const currentLen = exist.history?.length ?? 0;
        const isBranch =
          !msg.isChat &&
          ((exist.ownerUserId != null && exist.ownerUserId !== msg.userId) ||
            (ctxData.historyLength != null &&
              ctxData.historyLength !== currentLen));

        const targetSession: AiChatHist = isBranch
          ? {
              ...exist,
              sessionId: randomUUID(),
              postIds: [],
              ownerUserId: msg.userId,
              followUpUsed: false,
              history: (exist.history ?? []).slice(
                0,
                ctxData.historyLength ?? currentLen
              ),
            }
          : exist;

        return await this.executeChatTurn(targetSession, msg);
      });
    } finally {
      this.inFlightNoteIds.delete(msg.id);
    }
  }

  private async findExistingHistoryInChain(
    noteId: string,
    endpoint: 'notes/conversation' | 'notes/children'
  ): Promise<AiChatHist | null> {
    const data = await this.ai.api<Note[] | undefined>(endpoint, { noteId });
    if (data == undefined) return null;
    return this.history.findAnyByPostIds(data.map((message) => message.id));
  }

  @bindThis
  private async autoNote() {
    await postAutoNote({
      log: (message) => this.log(message),
      getProvider: () => this.getProvider(),
      genText: async (aiChat, files) => {
        const res = await this.genTextDetailed(aiChat, files);
        if (res == null || 'error' in res) return res;
        return `${res.text}${res.metadataSuffix}`;
      },
      post: (options) => this.ai.post(options),
    });
  }

  /**
   * アップグレード前に永続化されていた旧 timers レコードを安全にドレインする。
   * 進行中セッションの有効期限内であれば削除せず無視する。
   */
  @bindThis
  private async timeoutCallback(data: unknown) {
    const { isChat, userId, id } = (data ?? {}) as {
      isChat?: boolean;
      userId?: string;
      id?: string;
    };
    const exist =
      isChat && userId
        ? this.history.findChat(userId)
        : id
          ? this.history.findByPostId(id)
          : null;

    if (!exist) return;
    const expiresAt = exist.expiresAt ?? exist.createdAt + TIMEOUT_TIME;
    if (Date.now() < expiresAt) return;

    this.unsubscribeReply(exist.sessionId ?? exist.postId);
    this.history.remove(exist);
  }
}
