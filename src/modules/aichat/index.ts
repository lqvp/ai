import config from '@/config/index.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import type { Note } from '@/misskey/types.js';
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
import { DiaryRepository } from './diary-repository.js';
import {
  createAuxLlmCall,
  extractEpisodes,
  resolveContradictions,
} from './episode-extractor.js';
import type { EpisodeMemory } from './episode-memory.js';
import { EpisodeMemoryRepository } from './episode-memory-repository.js';
import { FollowupStateRepository } from './followup-state.js';
import {
  type AiChatHist,
  ChatHistoryRepository,
} from './history-repository.js';
import { buildMoodContextText, updateMood } from './mood-engine.js';
import {
  createDefaultMoodState,
  decayMood,
  type MoodState,
} from './mood-state.js';
import { selectNoteByLlm } from './note-selector.js';
import { runProactiveFollowUp } from './proactive-followup.js';
import { buildMemoryRecallContext } from './prompt-builder.js';
import { TextGenerator } from './text-generator.js';
import { buildDiaryContext, generateTlDiary } from './tl-diary.js';
import type { AiChat, Base64File, TimelineContext } from './types.js';
import {
  collectUrlInfo,
  formatTimelineContext,
  isYoutubeUrl,
} from './url-context.js';

export default class extends Module {
  public readonly name = 'aichat';
  private history!: ChatHistoryRepository;
  private memory!: EpisodeMemoryRepository;
  private memoryCollection!: import('lokijs').Collection<EpisodeMemory>;
  private followupState!: FollowupStateRepository;
  private diary!: DiaryRepository;
  private generator!: TextGenerator;
  private randomTalkProbability: number = DEFAULTS.RANDOMTALK_PROBABILITY;
  private randomTalkIntervalMs: number =
    DEFAULTS.RANDOMTALK_INTERVAL_HOURS * HOURS_TO_MS;

  private chatHandler!: ChatHandler;

  /** この生成ラウンドでLLMツールがリアクションを付けたノートIDと記録時刻 */
  private toolReactedNoteIds = new Map<string, number>();
  /** 記憶抽出処理を実行中のユーザーID（並走防止） */
  private memoryExtractionInFlight = new Set<string>();

  /** LLMが [[REACTION: ...]] マーカーで選んだリアクション（noteId → 絵文字 or null） */
  private personalizedReactionChoices = new Map<
    string,
    { reaction: string | null; ts: number }
  >();

  @bindThis
  public install() {
    this.history = new ChatHistoryRepository(
      this.ai.getCollection('aichatHist', {
        indices: ['postId', 'originalNoteId', 'chatUserId'],
      })
    );

    // エピソード記憶（会話から抽出した長期記憶）のリポジトリ。
    // プロアクティブ発話で全ユーザー横断のクエリが必要なため
    // 生のコレクション参照も保持する（リポジトリは読み取り専用制約のため変更しない）
    const memoryCollection = this.ai.getCollection<EpisodeMemory>(
      'aichatMemory',
      {
        indices: ['userId', 'createdAt'],
      }
    );
    this.memoryCollection = memoryCollection;
    this.memory = new EpisodeMemoryRepository(memoryCollection);

    // プロアクティブ発話（フォローアップ）のユーザーごとの状態
    this.followupState = new FollowupStateRepository(
      this.ai.getCollection('aichatFollowupState', {
        indices: ['userId'],
      })
    );

    // TL日記（タイムラインを見て藍が書く主観日記）のリポジトリ
    this.diary = new DiaryRepository(
      this.ai.getCollection('aichatDiary', {
        indices: ['createdAt'],
      })
    );

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
            // ツールによるリアクション成功を記録し、コアの自動リアクションと衝突しないようにする
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
      genText: (aiChat, files, msg) => this.genText(aiChat, files, msg),
      subscribeReply: (postId, isChat, userId) =>
        this.subscribeReply(postId, isChat, userId),
      setTimeoutWithPersistence: (delay, data) =>
        this.setTimeoutWithPersistence(delay, data),
      later: (ms, task) => this.later(ms, task),
      // エピソード記憶の回想コンテキスト（重要度4以上のみ・上限2000字）
      buildMemoryRecallContext: (userId) =>
        config.aichat?.episodeMemory?.enabled === false
          ? ''
          : buildMemoryRecallContext(this.memory.findByUserId(userId)),
      // 現在の気分の演技コンテキスト（気分エンジン有効時のみ）
      buildMoodContext: () =>
        config.aichat?.moodEngine?.enabled === false
          ? ''
          : buildMoodContextText(this.loadMoodState()),
      // LLMが選んだリアクションの受け取り口（パーソナライズ有効時のみ記録）
      registerReactionChoice: (noteId, reaction) => {
        // 気分エンジン全体が無効なら個別設定に関係なく記録しない
        if (config.aichat?.moodEngine?.enabled === false) {
          return;
        }
        if (config.aichat?.moodEngine?.reactionPersonalization === false) {
          return;
        }
        this.personalizedReactionChoices.set(noteId, {
          reaction,
          ts: Date.now(),
        });
      },
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

    // 気分エンジンの定期更新ジョブ（タイムライン文脈による気分メンテナンス）
    const moodConfig = config.aichat?.moodEngine;
    if (moodConfig?.enabled !== false) {
      const intervalHours = moodConfig?.updateIntervalHours ?? 6;
      this.every(intervalHours * HOURS_TO_MS, this.periodicMoodUpdate);
      this.log(`気分エンジンの定期更新を有効化: interval=${intervalHours}h`);
    }

    // TL日記の定期生成ジョブ。気分更新ジョブ（6h）と同間隔だが
    // 乱数オフセットを足して同時発火を避ける（APIレートとログの分散）
    const tlDiaryConfig = config.aichat?.tlDiary;
    if (tlDiaryConfig?.enabled !== false) {
      const intervalHours = tlDiaryConfig?.intervalHours ?? 6;
      const retentionHours = tlDiaryConfig?.retentionHours ?? 72;
      const maxEntries = tlDiaryConfig?.maxEntries ?? 20;
      this.every(
        intervalHours * HOURS_TO_MS + Math.random() * 30 * MINUTES_TO_MS,
        this.periodicTlDiary
      );
      this.log(
        `TL日記生成を有効化: interval=${intervalHours}h retention=${retentionHours}h maxEntries=${maxEntries}`
      );
    }

    // プロアクティブ発話の定期ジョブ（エピソード記憶に基づくフォローアップDM）
    const followupConfig = config.aichat?.proactiveFollowup;
    if (followupConfig?.enabled !== false) {
      const intervalHours = followupConfig?.intervalHours ?? 12;
      // 乱数オフセットで他ジョブとの同時発火を避ける。初回発火もこの間隔後
      this.every(
        intervalHours * HOURS_TO_MS + Math.random() * 30 * MINUTES_TO_MS,
        this.periodicProactiveFollowUp
      );
      this.log(
        `プロアクティブフォローアップを有効化: interval=${intervalHours}h`
      );
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
    // 並行生成で共有セットを一括クリアすると先着側の記録が消えるため、
    // 期限切れエントリ（1時間）のみを除去する方式にする
    const now = Date.now();
    for (const [id, ts] of this.toolReactedNoteIds) {
      if (now - ts > 3_600_000) this.toolReactedNoteIds.delete(id);
    }
    for (const [id, entry] of this.personalizedReactionChoices) {
      if (now - entry.ts > 3_600_000)
        this.personalizedReactionChoices.delete(id);
    }
    return this.generator.genText(this.getProvider(), aiChat, files, msg);
  }

  /**
   * コアの自動リアクション（like）を付けるか。
   * LLMツールが既にこのノートへリアクション済みなら null を返して抑制する
   * （Misskeyは1ノート1リアクションで、後付けが前の絵文字を上書きするため）。
   * パーソナライズドリアクションが有効な場合は LLM の選択で置き換える
   * （未選択・パース失敗時は既存どおり like にフォールバック）。
   */
  @bindThis
  private coreReactionFor(noteId: string): string | null {
    if (this.toolReactedNoteIds.has(noteId)) {
      this.log(
        'LLMツールが既にリアクション済みのため、コアの自動リアクションをスキップします'
      );
      return null;
    }
    const choice = this.personalizedReactionChoices.get(noteId);
    if (choice !== undefined) {
      // null は LLM が「リアクションしない」と選んだ場合
      return choice.reaction;
    }
    return 'like';
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
    current.quotedFiles = undefined;

    if (result) {
      return { reaction: this.coreReactionFor(msg.id) };
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
      return { reaction: this.coreReactionFor(msg.id) };
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

    let choseNote;

    // LLM による対象ノート選択（OpenAI互換プロバイダー時のみ有効）
    const useLlmSelection =
      config.gemini?.randomTalk?.llmSelection === true &&
      this.getProvider() === 'openai';

    if (useLlmSelection) {
      this.log('LLMによるランダムトーク対象の選択を実行します');
      const selectedIndex = await selectNoteByLlm(
        interestedNotes.map((note) => ({ id: note.id, text: note.text ?? '' })),
        (m) => this.log(m)
      );
      if (selectedIndex == null) {
        this.log('LLMは応答すべきノートがないと判断しました');
        return false;
      }
      choseNote = interestedNotes[selectedIndex];
    } else {
      if (Math.random() >= this.randomTalkProbability) return false;

      choseNote =
        interestedNotes[Math.floor(Math.random() * interestedNotes.length)];
    }

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

    // choseNote はタイムライン由来の生のNote。
    // extractedText が無い場合のみ取得し直してから Message として包み直す
    let messageSource = choseNote as Note & { extractedText?: unknown };
    if (messageSource.extractedText == undefined) {
      messageSource = await this.ai.api<Note>('notes/show', {
        noteId: choseNote.id,
      });
    }
    const targetedMessage = new Message(this.ai, messageSource, false);

    const result = await this.chatHandler.handle(current, targetedMessage);

    if (result) {
      return { reaction: this.coreReactionFor(choseNote.id) };
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
      // TL日記を独り言のネタとして渡す（最新2件・合計1000字まで）
      // 保持期間は設定値を反映する（既定72時間）
      buildDiaryContext: () =>
        config.aichat?.tlDiary?.enabled === false
          ? ''
          : buildDiaryContext(
              this.diary.findRecent({
                retentionHours: config.aichat?.tlDiary?.retentionHours ?? 72,
              })
            ),
    });
  }

  /**
   * 定期ジョブ: TL日記を生成して保存する（fire-and-forget相当の軽い処理）。
   * 失敗しても他機能に影響しないよう、エラーはログのみ。
   */
  @bindThis
  private async periodicTlDiary() {
    if (config.aichat?.tlDiary?.enabled === false) return;

    const tlDiaryConfig = config.aichat?.tlDiary;
    try {
      const api = createAuxLlmCall((m) => this.log(m));
      // 気分エンジン有効時のみ現在の気分を文脈として渡す（日記のトーン反映）
      const moodState =
        config.aichat?.moodEngine?.enabled === false
          ? null
          : this.loadMoodState();
      const entry = await generateTlDiary(
        {
          api: this.ai.api,
          selfUserId: this.ai.account.id,
          repository: this.diary,
          maxEntries: tlDiaryConfig?.maxEntries,
          log: (m) => this.log(m),
        },
        api,
        moodState
      );
      // 保持期間切れの日記をこのタイミングで掃除する
      const retentionHours = tlDiaryConfig?.retentionHours ?? 72;
      this.diary.pruneOldEntries(retentionHours);
      // 古い低重要度のエピソード記憶も同じ周期でアーカイブする
      this.memory.pruneOldMemories();
      if (entry == null) {
        this.log('TL日記: 生成をスキップしました');
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        this.log(`TL日記生成エラー: ${err.name} ${err.message}`);
      }
    }
  }

  /**
   * 定期ジョブ: エピソード記憶（重要度3以上）をLLMに見せて、
   * 気遣いのフォローアップを送るべきか判断し、送るならチャットDMで送る。
   * 失敗しても他機能に影響しないよう、runProactiveFollowUp 内部で例外は吸収される。
   */
  @bindThis
  private async periodicProactiveFollowUp() {
    if (config.aichat?.proactiveFollowup?.enabled === false) return;

    try {
      const api = createAuxLlmCall((m) => this.log(m));
      // 全ユーザーの有効な記憶（重要度3以上・アーカイブ/置換済み除外）を渡す
      const memories = this.memoryCollection
        .find({ importance: { $gte: 3 } })
        .filter((m) => m.archivedAt == null && m.supersededBy == null);

      const followupConfig = config.aichat?.proactiveFollowup;
      const throttleMs =
        (followupConfig?.userThrottleHours ?? 72) * HOURS_TO_MS;
      const cooldownMs = (followupConfig?.cooldownDays ?? 7) * 24 * HOURS_TO_MS;

      await runProactiveFollowUp(
        {
          memories,
          api,
          state: this.followupState,
          // フレンド（相互フォロー相当）でない相手には送らない
          isFriend: (userId) => this.ai.lookupFriend(userId) != null,
          isMasterUser: async (userId) => {
            try {
              const user = await this.ai.api<{
                username?: string;
                host?: string | null;
              } | null>('users/show', { userId });
              return this.ai.relationship.isMaster(user as never);
            } catch {
              return false;
            }
          },
          send: (userId, message) =>
            this.ai.sendMessage(userId, { text: message }),
          // フォローアップ後に会話が始まっていれば「反応あり」とみなす
          hasInteractedSince: async (userId, since) => {
            const exist = this.history.findChat(userId);
            return exist != null && exist.createdAt > since;
          },
          userThrottleMs: throttleMs,
          cooldownMs,
        },
        (m) => this.log(m)
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        this.log(
          `プロアクティブフォローアップエラー: ${err.name} ${err.message}`
        );
      }
    }
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
      // 会話の終了地点で長期記憶を抽出する（fire-and-forget）
      if (exist.history != null) {
        this.extractAndStoreMemories(exist.history, userId);
        // 同じ会話履歴テキストを再利用して気分も更新する（一体化フロー）
        this.updateMoodFromConversation(exist.history);
      }
    }
  }

  /** 気分状態を moduleData から読み出す（未初期化なら既定値を作る）。 */
  private loadMoodState(): MoodState {
    const data = this.getData() as { mood?: MoodState } | undefined;
    const state = data?.mood;
    if (state == null || typeof state.mood !== 'string') {
      return createDefaultMoodState();
    }
    // 読み出し時に前回からの自然減衰を適用する
    return decayMood(state);
  }

  private saveMoodState(state: MoodState): void {
    // LLM待ちの間に別の更新が保存されていると変化量制限を突破しうるため、
    // 保存直前の最新状態と比較して energy を再クランプする
    const latest = this.loadMoodState();
    const clampedEnergy = Math.max(
      latest.energy - 20,
      Math.min(latest.energy + 20, state.energy)
    );
    this.setData({ mood: { ...state, energy: clampedEnergy } });
  }

  /**
   * 会話終了時の気分更新（fire-and-forget）。
   * 失敗しても会話終了処理に影響しないよう、エラーはログのみ。
   */
  @bindThis
  private updateMoodFromConversation(
    history: { role: string; content: string }[]
  ): void {
    if (config.aichat?.moodEngine?.enabled === false) return;

    void (async () => {
      try {
        const api = createAuxLlmCall((m) => this.log(m));
        const current = this.loadMoodState();
        const next = await updateMood(
          current,
          {
            recentConversation: JSON.stringify(history),
            hour: new Date().getHours(),
          },
          api,
          (m) => this.log(m)
        );
        this.saveMoodState(next);
      } catch (err: unknown) {
        if (err instanceof Error) {
          this.log(`気分更新エラー: ${err.name} ${err.message}`);
        }
      }
    })();
  }

  /**
   * 定期ジョブ: タイムラインの流れを見て気分を更新する。
   * 会話がない時間帯でも気分が放置されないための補助。
   */
  @bindThis
  private async periodicMoodUpdate() {
    if (config.aichat?.moodEngine?.enabled === false) return;

    try {
      const tl = await this.ai.api<Note[]>('notes/timeline', { limit: 30 });
      const interested = this.filterInterestedNotes(tl ?? []);
      const timelineSummary = interested
        .map((note) => note.text ?? '')
        .join('\n');

      const api = createAuxLlmCall((m) => this.log(m));
      const current = this.loadMoodState();
      const next = await updateMood(
        current,
        { timelineSummary, hour: new Date().getHours() },
        api,
        (m) => this.log(m)
      );
      this.saveMoodState(next);
    } catch (err: unknown) {
      if (err instanceof Error) {
        this.log(`定期気分更新エラー: ${err.name} ${err.message}`);
      }
    }
  }

  /**
   * 会話履歴からエピソード記憶を抽出して保存する。
   * 抽出LLMの失敗が会話終了処理を壊さないよう、非同期で実行し
   * エラーはログに記録するだけにする。
   */
  @bindThis
  private extractAndStoreMemories(
    history: { role: string; content: string }[],
    userId: string
  ): void {
    const episodeConfig = config.aichat?.episodeMemory;
    if (episodeConfig?.enabled === false) return;

    // 同一ユーザーの抽出が並走すると、両方が同じ既存記憶を読んで
    // 矛盾解消を壊すため、処理中のユーザーはスキップする
    if (this.memoryExtractionInFlight.has(userId)) return;
    this.memoryExtractionInFlight.add(userId);

    void (async () => {
      try {
        const api = createAuxLlmCall((m) => this.log(m));
        const log = (m: string) => this.log(m);
        const newMemories = await extractEpisodes(history, userId, api, log);
        if (newMemories.length === 0) return;

        const existing = this.memory.findByUserId(userId);
        const supersedeMap = await resolveContradictions(
          newMemories,
          existing,
          api,
          log
        );

        const maxMemories = episodeConfig?.maxMemoriesPerUser ?? 50;
        let insertedCount = 0;
        for (const [index, memory] of newMemories.entries()) {
          if (this.memory.countByUserId(userId) >= maxMemories) {
            this.log(
              `記憶件数が上限(${maxMemories})に達したため挿入をスキップします`
            );
            break;
          }
          const inserted = this.memory.insert(memory);
          insertedCount++;
          for (const oldId of supersedeMap.get(index) ?? []) {
            this.memory.markSuperseded(oldId, inserted.id);
          }
        }
        this.log(`エピソード記憶を${insertedCount}件保存しました`);
      } catch (err: unknown) {
        if (err instanceof Error) {
          this.log(`エピソード記憶の抽出エラー: ${err.name} ${err.message}`);
        }
      } finally {
        this.memoryExtractionInFlight.delete(userId);
      }
    })();
  }
}
