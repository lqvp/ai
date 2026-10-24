import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import type { Note } from '@/misskey/note.js';
import Module from '@/module.js';
import { fetchNoteFiles } from '@/services/media.js';
import { postAutoNote } from './auto-note.js';
import { ChatHandler } from './chat-handler.js';
import {
  DEFAULTS,
  HOURS_TO_MS,
  MINUTES_TO_MS,
  TYPE_GEMINI,
} from './constants.js';
import {
  type AiChatHist,
  ChatHistoryRepository,
} from './history-repository.js';
import { TextGenerator } from './text-generator.js';
import type { AiChat, Base64File, TimelineContext } from './types.js';
import {
  collectUrlInfo,
  formatTimelineContext,
  isYoutubeUrl,
} from './url-context.js';

export default class extends Module {
  public readonly name = 'aichat';
  private history!: ChatHistoryRepository;
  private generator!: TextGenerator;
  private randomTalkProbability: number = DEFAULTS.RANDOMTALK_PROBABILITY;
  private randomTalkIntervalMs: number =
    DEFAULTS.RANDOMTALK_INTERVAL_HOURS * HOURS_TO_MS;

  private chatHandler!: ChatHandler;

  @bindThis
  public install() {
    this.history = new ChatHistoryRepository(
      this.ai.getCollection('aichatHist', {
        indices: ['postId', 'originalNoteId', 'chatUserId'],
      })
    );

    this.generator = new TextGenerator({
      log: (message) => this.log(message),
      isMasterUser: (msg) => this.isMasterUser(msg),
      isYoutubeUrl,
      collectUrlInfo: (aiChat) => collectUrlInfo(aiChat, (m) => this.log(m)),
      formatTimelineContext,
    });

    this.chatHandler = new ChatHandler({
      ai: this.ai,
      moduleName: this.name,
      history: this.history,
      log: (message) => this.log(message),
      genText: (aiChat, files, msg) => this.genText(aiChat, files, msg),
      subscribeReply: (postId, isChat, userId) =>
        this.subscribeReply(postId, isChat, userId),
      setTimeoutWithPersistence: (delay, data) =>
        this.setTimeoutWithPersistence(delay, data),
      later: (ms, task) => this.later(ms, task),
    });

    // Gemini全体が有効かチェック
    if (!config.gemini?.enabled) {
      this.log('Gemini機能が無効になっています');
      return false;
    }

    // ランダムトーク設定
    const randomTalkConfig = config.gemini.randomTalk;
    if (
      randomTalkConfig?.probability !== undefined &&
      !Number.isNaN(randomTalkConfig.probability)
    ) {
      this.randomTalkProbability = randomTalkConfig.probability;
    }
    if (
      randomTalkConfig?.intervalMinutes !== undefined &&
      !Number.isNaN(randomTalkConfig.intervalMinutes)
    ) {
      this.randomTalkIntervalMs =
        randomTalkConfig.intervalMinutes * MINUTES_TO_MS;
    }

    this.log(
      'Gemini randomTalk enabled: ' + (randomTalkConfig?.enabled || false)
    );
    this.log(
      'randomTalkProbability:' +
        this.randomTalkProbability +
        ' randomTalkIntervalMs:' +
        this.randomTalkIntervalMs
    );
    this.log(
      'Gemini chat grounding enabled: ' +
        (config.gemini.chat?.groundingWithGoogleSearch || false)
    );

    // ランダムトークのインターバル設定
    if (randomTalkConfig?.enabled) {
      this.every(this.randomTalkIntervalMs, this.aichatRandomTalk);
      this.log(
        'Geminiランダムトーク機能を有効化: interval=' +
          this.randomTalkIntervalMs
      );
    }

    // 自動ノート投稿の設定
    const autoNoteConfig = config.gemini.autoNote;
    if (autoNoteConfig?.enabled) {
      const interval =
        autoNoteConfig.intervalMinutes !== undefined &&
        !isNaN(autoNoteConfig.intervalMinutes)
          ? 1000 * 60 * autoNoteConfig.intervalMinutes
          : DEFAULTS.AUTO_NOTE_INTERVAL_HOURS * HOURS_TO_MS;
      this.every(
        interval +
          Math.random() *
            ((DEFAULTS.AUTO_NOTE_INTERVAL_HOURS * HOURS_TO_MS) / 20),
        this.autoNote
      );
      this.log('Gemini自動ノート投稿を有効化: interval=' + interval);

      const probability =
        autoNoteConfig.probability !== undefined &&
        !isNaN(autoNoteConfig.probability)
          ? autoNoteConfig.probability
          : DEFAULTS.AUTO_NOTE_PROBABILITY;
      this.log('Gemini自動ノート投稿確率: probability=' + probability);
    }

    return {
      mentionHook: this.mentionHook,
      contextHook: this.contextHook,
      timeoutCallback: this.timeoutCallback,
    };
  }

  @bindThis
  private getProvider(): 'gemini' | 'openai' {
    return config.aiProvider?.provider || 'gemini';
  }

  @bindThis
  private async genText(
    aiChat: AiChat,
    files: Base64File[],
    msg?: Message
  ): Promise<string | import('./types.js').ApiErrorResponse | null> {
    return this.generator.genText(this.getProvider(), aiChat, files, msg);
  }

  @bindThis
  private isFollowing(userId: string): Promise<boolean> {
    return this.ai.relationship.isFollowing(userId);
  }

  @bindThis
  private isMasterUser(msg: Message): boolean {
    return this.ai.relationship.isMaster(msg.user);
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.includes([this.name])) {
      return false;
    } else {
      this.log('AiChat requested');

      if (!(await this.isFollowing(msg.userId))) {
        this.log('The user is not following me:' + msg.userId);
        msg.reply('あなたはaichatを実行する権限がありません。');
        return false;
      }
    }

    let exist: AiChatHist | null = null;

    // チャットメッセージの場合、会話APIは使わず直接処理する
    if (msg.isChat) {
      exist = this.history.findChat(msg.userId);

      if (exist != null) return false;
    } else {
      exist = await this.findExistingHistoryInChain(
        msg.id,
        'notes/conversation'
      );
      if (exist != null) return false;
    }

    let type = TYPE_GEMINI;
    const current: AiChatHist = {
      postId: msg.id,
      createdAt: Date.now(),
      type: type,
      fromMention: true,
      isChat: msg.isChat,
      chatUserId: msg.isChat ? msg.userId : undefined,
    };

    if (msg.quoteId) {
      const quotedNote = await this.ai.api<Partial<{ text: string }>>(
        'notes/show',
        {
          noteId: msg.quoteId,
        }
      );
      current.history = [
        {
          role: 'user',
          content:
            'ユーザーが与えた前情報である、引用された文章: ' + quotedNote.text,
        },
      ];
      current.quotedFiles = await fetchNoteFiles(this.ai.api, msg.quoteId, {
        includeUrl: true,
        log: (m) => this.log(m),
      });
    }

    const result = await this.chatHandler.handle(current, msg);

    if (result) {
      return { reaction: 'like' };
    }
    return false;
  }

  @bindThis
  private async contextHook(key: string | null, msg: Message) {
    this.log('contextHook...');
    if (msg.text == null) return false;

    // チャットモードでaichatを終了するコマンドを追加
    if (
      msg.isChat &&
      (msg.includes(['aichat 終了']) ||
        msg.includes(['aichat 終わり']) ||
        msg.includes(['aichat やめる']) ||
        msg.includes(['aichat 止めて']))
    ) {
      const exist = this.history.findChat(msg.userId);

      if (exist != null) {
        this.history.remove(exist);
        this.unsubscribeReply(key);
        msg.reply(
          '藍チャットを終了しました。また何かあればお声がけくださいね！'
        );
        return true;
      }
    }

    let exist: AiChatHist | null = null;

    // チャットメッセージの場合
    if (msg.isChat) {
      exist = this.history.findChat(msg.userId);
    } else {
      const conversationData = await this.ai.api<Note[]>('notes/conversation', {
        noteId: msg.id,
      });

      if (conversationData == null || conversationData.length == 0) {
        this.log('conversationData is nothing.');
        return false;
      }

      exist = this.history.findAnyByPostIds(
        conversationData.map((message) => message.id)
      );
    }

    if (exist == null) {
      this.log('conversation context is not found.');
      return false;
    }

    if (!(await this.isFollowing(msg.userId))) {
      this.log('The user is not following me: ' + msg.userId);
      msg.reply('あなたはaichatを実行する権限がありません。');
      return false;
    }

    this.unsubscribeReply(key);
    this.history.remove(exist);

    const result = await this.chatHandler.handle(exist, msg);

    if (result) {
      return { reaction: 'like' };
    }
    return false;
  }

  /**
   * 会話チェーン（ノートの会話・返信ツリー）の投稿IDを履歴と照合し、
   * 既出の会話ならその履歴を返す。APIが値を返さなければ null。
   */
  private async findExistingHistoryInChain(
    noteId: string,
    endpoint: 'notes/conversation' | 'notes/children'
  ): Promise<AiChatHist | null> {
    const data = await this.ai.api<Note[] | undefined>(endpoint, { noteId });
    if (data == undefined) return null;
    return this.history.findAnyByPostIds(data.map((message) => message.id));
  }

  // フィルタリング処理を関数化
  private filterInterestedNotes(notes: Note[]): Note[] {
    return notes.filter(
      (note) =>
        note.userId !== this.ai.account.id &&
        note.text != null &&
        note.replyId == null &&
        note.renoteId == null &&
        note.cw == null &&
        (note.visibility === 'public' || note.visibility === 'home') &&
        note.files?.length == 0 &&
        !note.user.isBot
    );
  }

  // ユーザー投稿履歴から文脈取得関数
  private async getUserNotesContext(
    selectedNote: Note,
    userId: string,
    contextRange: number = 5,
    contextUsageCount: number = 3
  ): Promise<TimelineContext> {
    try {
      // 並列でAPI呼び出しを実行
      const [newerNotes, olderNotes] = await Promise.all([
        this.ai.api<Note[]>('users/notes', {
          userId: userId,
          sinceId: selectedNote.id,
          limit: contextRange,
        }),
        this.ai.api<Note[]>('users/notes', {
          userId: userId,
          untilId: selectedNote.id,
          limit: contextRange,
        }),
      ]);

      // フィルタリング適用
      const filteredNewer = newerNotes
        ? this.filterInterestedNotes(newerNotes)
        : [];
      const filteredOlder = olderNotes
        ? this.filterInterestedNotes(olderNotes)
        : [];

      // contextUsageCount分だけ取得（選択された投稿に近い順）
      const beforeContext = filteredOlder.slice(0, contextUsageCount);
      const afterContext = filteredNewer.slice(0, contextUsageCount);

      return {
        before: beforeContext.length > 0 ? beforeContext : undefined,
        after: afterContext.length > 0 ? afterContext : undefined,
      };
    } catch (error) {
      this.log(`Error fetching user notes context: ${error}`);
      return {};
    }
  }

  @bindThis
  private async aichatRandomTalk() {
    this.log('aichatRandomTalk called');
    const tl = await this.ai.api<Note[]>('notes/timeline', { limit: 30 });
    const interestedNotes = this.filterInterestedNotes(tl);

    if (interestedNotes == undefined || interestedNotes.length == 0)
      return false;

    if (Math.random() >= this.randomTalkProbability) return false;

    const choseNote =
      interestedNotes[Math.floor(Math.random() * interestedNotes.length)];

    let exist: AiChatHist | null = null;

    exist = this.history.findByPostId(choseNote.id);
    if (exist != null) return false;

    exist = await this.findExistingHistoryInChain(
      choseNote.id,
      'notes/children'
    );
    if (exist != null) return false;

    exist = await this.findExistingHistoryInChain(
      choseNote.id,
      'notes/conversation'
    );
    if (exist != null) return false;

    exist = this.history.findByOriginalNoteId(choseNote.id);
    if (exist != null) {
      this.log('Already replied to this note via originalNoteId');
      return false;
    }

    if (choseNote.user.isBot) return false;

    // フォロー制限設定のチェック
    const followingOnly = config.gemini?.randomTalk?.followingOnly;
    const isFollowingUser = await this.isFollowing(choseNote.userId);

    if (followingOnly && !isFollowingUser) {
      return false;
    }

    // 文脈取得
    const contextRange = config.gemini?.randomTalk?.contextRange || 5;
    const contextUsageCount = config.gemini?.randomTalk?.contextUsageCount || 3;
    const enableContext = config.gemini?.randomTalk?.enableContext !== false; // デフォルトtrue
    let timelineContext: TimelineContext = {};

    if (enableContext) {
      timelineContext = await this.getUserNotesContext(
        choseNote,
        choseNote.userId,
        contextRange,
        contextUsageCount
      );
    }

    const current: AiChatHist = {
      postId: choseNote.id,
      createdAt: Date.now(),
      type: TYPE_GEMINI,
      fromMention: false,
      timelineContext: timelineContext, // 文脈情報を保存
    };

    // choseNote はタイムライン由来の生のNoteなので、Messageとして包み直す
    const shownNote = await this.ai.api<Note>('notes/show', {
      noteId: choseNote.id,
    });
    const targetedMessage = new Message(this.ai, shownNote, false);

    const result = await this.chatHandler.handle(current, targetedMessage);

    if (result) {
      return { reaction: 'like' };
    }

    return false;
  }

  @bindThis
  private async autoNote() {
    await postAutoNote({
      log: (message) => this.log(message),
      getProvider: () => this.getProvider(),
      genText: (aiChat, files) => this.genText(aiChat, files),
      post: (options) => this.ai.post(options),
    });
  }

  @bindThis
  private async timeoutCallback(data: unknown) {
    const { isChat, userId, id } = data as {
      isChat?: boolean;
      userId: string;
      id: string;
    };
    this.log('timeoutCallback...');
    let exist: AiChatHist | null = null;

    if (isChat) {
      exist = this.history.findChat(userId);
      this.unsubscribeReply(userId);
    } else {
      exist = this.history.findByPostId(id);
      this.unsubscribeReply(id);
    }

    if (exist != null) {
      this.history.remove(exist);
    }
  }
}
