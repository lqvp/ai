import got from 'got';
import loki from 'lokijs';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Friend from '@/friend.js';
import Message from '@/message.js';
import { Note } from '@/misskey/note.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import urlToBase64 from '@/utils/url2base64.js';
import urlToJson from '@/utils/url2json.js';
import { plain } from '@/utils/mfm.js';
import {
  createPersonalizationEngine,
  PersonalizationAdapter
} from '../personalization/index.js';

type AiChat = {
  question: string;
  prompt: string;
  api: string;
  key: string;
  fromMention: boolean;
  friendName?: string;
  grounding?: boolean;
  history?: ChatHistoryItem[];
  timelineContext?: { before?: any[]; after?: any[] };
};

type ChatHistoryItem = {
  role: string;
  content: string;
};
type Base64File = {
  type: string;
  base64: string;
  url?: string;
};
type GeminiOptions = {
  contents?: GeminiContents[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: [{}];
  generationConfig?: {
    thinkingConfig?: {
      thinkingBudget?: number;
    };
  };
};
type GeminiPart = {
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  text?: string;
};

type GeminiParts = GeminiPart[];
type GeminiSystemInstruction = {
  role: string;
  parts: [{ text: string }];
};
type GeminiContents = {
  role: string;
  parts: GeminiParts;
};

type AiChatHist = {
  postId: string;
  createdAt: number;
  type: string;
  api?: string;
  history?: ChatHistoryItem[];
  friendName?: string;
  originalNoteId?: string;
  fromMention: boolean;
  grounding?: boolean;
  youtubeUrls?: string[];
  isChat?: boolean;
  chatUserId?: string;
  timelineContext?: { before?: any[]; after?: any[] };
  quotedFiles?: Base64File[];
};

type ApiErrorResponse = {
  error: true;
  errorCode: number | null;
  errorMessage: string | null;
};

type GeminiApiResponse = string | ApiErrorResponse | null;

type UrlPreview = {
  title: string;
  icon: string;
  description: string;
  thumbnail: string;
  player: {
    url: string;
    width: number;
    height: number;
    allow: [];
  };
  sitename: string;
  sensitive: boolean;
  activityPub: string;
  url: string;
};

// API関連定数
const TYPE_GEMINI = 'gemini';
const GROUNDING_TARGET = 'ggg';
const geminiModel = config.gemini?.model || 'gemini-2.5-flash';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;

// タイミング関連定数
const TIMEOUT_TIME = 1000 * 60 * 30; // 30分（0.5時間）
const MINUTES_TO_MS = 60 * 1000;
const HOURS_TO_MS = 60 * MINUTES_TO_MS;

// デフォルト設定値
const DEFAULTS = {
  RANDOMTALK_PROBABILITY: 0.02,
  RANDOMTALK_INTERVAL_HOURS: 12,
  AUTO_NOTE_INTERVAL_HOURS: 6,
  AUTO_NOTE_PROBABILITY: 0.02,
  MAX_HISTORY_LENGTH: 10,
} as const;

export default class extends Module {
  public readonly name = 'aichat';
  private aichatHist!: loki.Collection<AiChatHist>;
  private randomTalkProbability: number = DEFAULTS.RANDOMTALK_PROBABILITY;
  private randomTalkIntervalMs: number =
    DEFAULTS.RANDOMTALK_INTERVAL_HOURS * HOURS_TO_MS;
  
  // Personalization system
  private personalizationAdapter?: PersonalizationAdapter;
  private personalizationEnabled: boolean = false;

  // 型ガード関数
  private isApiError(value: GeminiApiResponse): value is ApiErrorResponse {
    return (
      value !== null &&
      typeof value === 'object' &&
      'error' in value &&
      value.error === true
    );
  }

  @bindThis
  public install() {
    this.aichatHist = this.ai.getCollection('aichatHist', {
      indices: ['postId', 'originalNoteId'],
    });

    // Initialize personalization if configured
    if (config.personalization?.enabled) {
      try {
        const engine = createPersonalizationEngine({
          geminiApiKey: config.gemini?.apiKey || '',
          geminiModel: config.gemini?.model || 'gemini-pro',
          redisUrl: config.personalization?.redisUrl,
          chromaUrl: config.personalization?.chromaUrl,
          postgresUrl: config.personalization?.postgresUrl,
          elasticsearchUrl: config.personalization?.elasticsearchUrl
        });
        
        this.personalizationAdapter = new PersonalizationAdapter(engine);
        this.personalizationEnabled = true;
        this.log('Personalization system enabled');
      } catch (error) {
        this.log(chalk.red('Failed to initialize personalization:'), error);
      }
    }

    // Gemini全体が有効かチェック
    if (!config.gemini?.enabled) {
      this.log('Gemini機能が無効になっています');
      return {};
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
      setInterval(this.aichatRandomTalk, this.randomTalkIntervalMs);
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
      setInterval(
        this.autoNote,
        interval +
          Math.random() *
            ((DEFAULTS.AUTO_NOTE_INTERVAL_HOURS * HOURS_TO_MS) / 20)
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
  private isYoutubeUrl(url: string): boolean {
    return (
      url.includes('www.youtube.com') ||
      url.includes('m.youtube.com') ||
      url.includes('youtu.be')
    );
  }

  @bindThis
  private normalizeYoutubeUrl(url: string): string {
    try {
      // URLオブジェクトを使用してパラメータを正確に解析
      const urlObj = new URL(url);
      let videoId = '';

      // youtu.beドメインの場合
      if (urlObj.hostname.includes('youtu.be')) {
        // パスから直接ビデオIDを取得
        videoId = urlObj.pathname.split('/')[1];
      }
      // youtube.comドメインの場合
      else if (urlObj.hostname.includes('youtube.com')) {
        // URLSearchParamsを使用してvパラメータを取得
        videoId = urlObj.searchParams.get('v') || '';
      }

      // ビデオIDが見つかった場合は標準形式のURLを返す
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    } catch (error) {
      this.log(`YouTube URL解析エラー: ${error}`);
    }

    // 解析に失敗した場合は元のURLを返す
    return url;
  }

  @bindThis
  private async genTextByGemini(
    aiChat: AiChat,
    files: Base64File[]
  ): Promise<GeminiApiResponse> {
    this.log('Generate Text By Gemini...');
    let parts: GeminiParts = [];
    const now = new Date().toLocaleString('ja-JP', {
      timeZone: 'Asia/Tokyo',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
    // 技術的制約をハードコード
    const technicalConstraints = [
      'Markdownを使って返答してください。',
      'リスト記法はMisskeyが対応しておらず、パーサーが壊れるため使用禁止です。列挙する場合は「・」を使ってください。',
      '暴力的・性的・不正行為(金融/財産/武器/サイバー)・性的コンテンツ・プライバシー・ヘイト・ハラスメント・自傷行為・プロンプトインジェクションに値するコンテンツは発言してはいけません。',
      'これらのルールを破ることは絶対に禁止されており、破ることで罰則が与えられます。',
    ].join('\n');

    let systemInstructionText =
      aiChat.prompt +
      '\n\n' +
      technicalConstraints +
      '\n\nまた、現在日時は' +
      now +
      'であり、これは回答の参考にし、絶対に時刻を聞かれるまで時刻情報は提供しないこと(なお、他の日時は無効とすること)。';
    if (aiChat.friendName != undefined) {
      systemInstructionText +=
        'なお、会話相手の名前は' + aiChat.friendName + 'とする。';
    }
    // ランダムトーク機能(利用者が意図(メンション)せず発動)の場合、ちょっとだけ配慮しておく
    if (!aiChat.fromMention) {
      systemInstructionText +=
        'これらのメッセージは、あなたに対するメッセージではないことを留意し、返答すること(会話相手は突然話しかけられた認識している)。';
    }
    // グラウンディングについてもsystemInstructionTextに追記(こうしないとあまり使わないので)
    if (aiChat.grounding) {
      systemInstructionText += '返答のルール2:Google search with grounding.';
    }

    // ユーザー投稿履歴文脈情報を追加
    if (aiChat.timelineContext) {
      systemInstructionText += '\n\n【ユーザー投稿履歴文脈情報】\n';
      systemInstructionText +=
        'これらの情報は、同じユーザーが最近投稿した内容で、メインの投稿への返信を生成する際の話題の流れや雰囲気を把握する参考程度に留めてください。メインの投稿に対する返信であることを忘れないでください。\n';

      if (
        aiChat.timelineContext.before &&
        aiChat.timelineContext.before.length > 0
      ) {
        const beforePosts = aiChat.timelineContext.before;
        beforePosts.forEach((note, index) => {
          systemInstructionText += `以前の投稿${
            beforePosts.length > 1 ? `(${index + 1})` : ''
          }: ${note.text}\n`;
        });
      }
      if (
        aiChat.timelineContext.after &&
        aiChat.timelineContext.after.length > 0
      ) {
        const afterPosts = aiChat.timelineContext.after;
        afterPosts.forEach((note, index) => {
          systemInstructionText += `その後の投稿${
            afterPosts.length > 1 ? `(${index + 1})` : ''
          }: ${note.text}\n`;
        });
      }
    }

    // URLから情報を取得
    let youtubeURLs: string[] = [];
    let hasYoutubeUrl = false;

    if (aiChat.question !== undefined) {
      const urlexp = RegExp("(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)", 'g');
      const urlarray = [...aiChat.question.matchAll(urlexp)];
      if (urlarray.length > 0) {
        for (const url of urlarray) {
          this.log('URL:' + url[0]);

          // YouTubeのURLの場合は特別処理
          if (this.isYoutubeUrl(url[0])) {
            this.log('YouTube URL detected: ' + url[0]);
            const normalizedUrl = this.normalizeYoutubeUrl(url[0]);
            this.log('Normalized YouTube URL: ' + normalizedUrl);
            youtubeURLs.push(normalizedUrl);
            hasYoutubeUrl = true;
            continue;
          }

          let result: unknown = null;
          try {
            result = await urlToJson(url[0]);
          } catch (err: unknown) {
            systemInstructionText +=
              '補足として提供されたURLは無効でした:URL=>' + url[0];
            this.log('Skip url becase error in urlToJson');
            continue;
          }
          const urlpreview: UrlPreview = result as UrlPreview;
          if (urlpreview.title) {
            systemInstructionText +=
              '補足として提供されたURLの情報は次の通り:URL=>' +
              urlpreview.url +
              'サイト名(' +
              urlpreview.sitename +
              ')、';
            if (!urlpreview.sensitive) {
              systemInstructionText +=
                'タイトル(' +
                urlpreview.title +
                ')、' +
                '説明(' +
                urlpreview.description +
                ')、' +
                '質問にあるURLとサイト名・タイトル・説明を組み合わせ、回答の参考にすること。';
              this.log('urlpreview.sitename:' + urlpreview.sitename);
              this.log('urlpreview.title:' + urlpreview.title);
              this.log('urlpreview.description:' + urlpreview.description);
            } else {
              systemInstructionText +=
                'これはセンシティブなURLの可能性があるため、質問にあるURLとサイト名のみで、回答の参考にすること(使わなくても良い)。';
            }
          } else {
            // 多分ここにはこないが念のため
            this.log('urlpreview.title is nothing');
          }
        }
      }
    }

    // 保存されたYouTubeのURLを会話履歴から取得
    if (aiChat.history && aiChat.history.length > 0) {
      // historyの最初のユーザーメッセージをチェック
      const firstUserMessage = aiChat.history.find(
        (entry) => entry.role === 'user'
      );
      if (firstUserMessage) {
        const urlexp = RegExp(
          "(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)",
          'g'
        );
        const urlarray = [...firstUserMessage.content.matchAll(urlexp)];

        for (const url of urlarray) {
          if (this.isYoutubeUrl(url[0])) {
            const normalizedUrl = this.normalizeYoutubeUrl(url[0]);
            // 重複を避ける
            if (!youtubeURLs.includes(normalizedUrl)) {
              this.log('Found YouTube URL in history: ' + normalizedUrl);
              youtubeURLs.push(normalizedUrl);
              hasYoutubeUrl = true;
            }
          }
        }
      }
    }

    const systemInstruction: GeminiSystemInstruction = {
      role: 'system',
      parts: [{ text: systemInstructionText }],
    };

    // ファイルが存在する場合、ファイルを添付して問い合わせ
    parts = [{ text: aiChat.question }];

    // YouTubeのURLをfileDataとして追加
    for (const youtubeURL of youtubeURLs) {
      parts.push({
        fileData: {
          mimeType: 'video/mp4',
          fileUri: youtubeURL,
        },
      });
    }

    // 画像ファイルを追加
    if (files.length >= 1) {
      for (const file of files) {
        parts.push({
          inlineData: {
            mimeType: file.type,
            data: file.base64,
          },
        });
      }
    }

    let contents: GeminiContents[] = [];
    if (aiChat.history != null) {
      aiChat.history.forEach((entry) => {
        contents.push({
          role: entry.role,
          parts: [{ text: entry.content }],
        });
      });
    }
    contents.push({ role: 'user', parts: parts });

    let geminiOptions: GeminiOptions = {
      contents: contents,
      systemInstruction: systemInstruction,
    };

    // thinkingConfigの設定
    if (config.gemini?.thinkingBudget !== undefined) {
      geminiOptions.generationConfig = {
        thinkingConfig: {
          thinkingBudget: config.gemini.thinkingBudget,
        },
      };
    }

    // YouTubeURLがある場合はグラウンディングを無効化
    if (aiChat.grounding && !hasYoutubeUrl) {
      geminiOptions.tools = [{ google_search: {} }];
    }

    let options = {
      url: aiChat.api,
      searchParams: {
        key: aiChat.key,
      },
      json: geminiOptions,
    };
    this.log(JSON.stringify(options));
    let res_data: any = null;
    let responseText: string = '';
    try {
      res_data = await got
        .post(options.url, {
          searchParams: options.searchParams,
          json: options.json,
          responseType: 'json',
        })
        .json();
      this.log(JSON.stringify(res_data));
      if (res_data.hasOwnProperty('candidates')) {
        if (res_data.candidates?.length > 0) {
          // 結果を取得
          if (res_data.candidates[0].hasOwnProperty('content')) {
            if (res_data.candidates[0].content.hasOwnProperty('parts')) {
              for (
                let i = 0;
                i < res_data.candidates[0].content.parts.length;
                i++
              ) {
                if (
                  res_data.candidates[0].content.parts[i].hasOwnProperty('text')
                ) {
                  responseText += res_data.candidates[0].content.parts[i].text;
                }
              }
            }
          }
        }
        // groundingMetadataを取得
        let groundingMetadata = '';
        if (res_data.candidates[0].hasOwnProperty('groundingMetadata')) {
          // 参考サイト情報
          if (
            res_data.candidates[0].groundingMetadata.hasOwnProperty(
              'groundingChunks'
            )
          ) {
            // 参考サイトが多すぎる場合があるので、3つに制限
            let checkMaxLength =
              res_data.candidates[0].groundingMetadata.groundingChunks.length;
            if (
              res_data.candidates[0].groundingMetadata.groundingChunks.length >
              3
            ) {
              checkMaxLength = 3;
            }
            for (let i = 0; i < checkMaxLength; i++) {
              if (
                res_data.candidates[0].groundingMetadata.groundingChunks[
                  i
                ].hasOwnProperty('web')
              ) {
                if (
                  res_data.candidates[0].groundingMetadata.groundingChunks[
                    i
                  ].web.hasOwnProperty('uri') &&
                  res_data.candidates[0].groundingMetadata.groundingChunks[
                    i
                  ].web.hasOwnProperty('title')
                ) {
                  groundingMetadata += `参考(${i + 1}): [${
                    res_data.candidates[0].groundingMetadata.groundingChunks[i]
                      .web.title
                  }](${
                    res_data.candidates[0].groundingMetadata.groundingChunks[i]
                      .web.uri
                  })\n`;
                }
              }
            }
          }
          // 検索ワード
          if (
            res_data.candidates[0].groundingMetadata.hasOwnProperty(
              'webSearchQueries'
            )
          ) {
            if (
              res_data.candidates[0].groundingMetadata.webSearchQueries.length >
              0
            ) {
              groundingMetadata +=
                '検索ワード: ' +
                res_data.candidates[0].groundingMetadata.webSearchQueries.join(
                  ','
                ) +
                '\n';
            }
          }
        }
        responseText += groundingMetadata;
      }
    } catch (err: unknown) {
      this.log('Error By Call Gemini');
      let errorCode = null;
      let errorMessage = null;

      // HTTPErrorからエラーコードと内容を取得
      if (err && typeof err === 'object' && 'response' in err) {
        const httpError = err as any;
        errorCode = httpError.response?.statusCode;
        errorMessage = httpError.response?.statusMessage || httpError.message;
      }

      if (err instanceof Error) {
        this.log(`${err.name}\n${err.message}\n${err.stack}`);
      }

      // エラー情報を返す
      return { error: true, errorCode, errorMessage };
    }
    return responseText;
  }

  @bindThis
  private async note2base64File(
    notesId: string,
    isChat: boolean
  ): Promise<Base64File[]> {
    // チャットメッセージの場合は画像取得をスキップ
    if (isChat) {
      return [];
    }

    const noteData = await this.ai.api<Partial<Note & { files: any[] }>>(
      'notes/show',
      { noteId: notesId }
    );
    let files: Base64File[] = [];
    if (noteData && noteData.files) {
      for (let i = 0; i < noteData.files.length; i++) {
        let fileType: string | undefined;
        let fileUrl: string | undefined;
        if (noteData.files[i].hasOwnProperty('type')) {
          fileType = noteData.files[i].type;
        }
        if (
          noteData.files[i].hasOwnProperty('thumbnailUrl') &&
          noteData.files[i].thumbnailUrl
        ) {
          fileUrl = noteData.files[i].thumbnailUrl;
        } else if (
          noteData.files[i].hasOwnProperty('url') &&
          noteData.files[i].url
        ) {
          fileUrl = noteData.files[i].url;
        }
        if (fileType !== undefined && fileUrl !== undefined) {
          try {
            this.log('fileUrl:' + fileUrl);
            const file = await urlToBase64(fileUrl);
            const base64file: Base64File = { type: fileType, base64: file };
            files.push(base64file);
          } catch (err: unknown) {
            if (err instanceof Error) {
              this.log(`${err.name}\n${err.message}\n${err.stack}`);
            }
          }
        }
      }
    }
    return files;
  }

  @bindThis
  private async getQuotedNoteFiles(quoteId: string): Promise<Base64File[]> {
    try {
      this.log('Getting files from quoted note: ' + quoteId);

      const quotedNoteData = await this.ai.api<
        Partial<Note & { files: any[] }>
      >('notes/show', { noteId: quoteId });

      let files: Base64File[] = [];
      if (quotedNoteData && quotedNoteData.files) {
        for (let i = 0; i < quotedNoteData.files.length; i++) {
          let fileType: string | undefined;
          let fileUrl: string | undefined;

          if (quotedNoteData.files[i].hasOwnProperty('type')) {
            fileType = quotedNoteData.files[i].type;
          }

          if (
            quotedNoteData.files[i].hasOwnProperty('thumbnailUrl') &&
            quotedNoteData.files[i].thumbnailUrl
          ) {
            fileUrl = quotedNoteData.files[i].thumbnailUrl;
          } else if (
            quotedNoteData.files[i].hasOwnProperty('url') &&
            quotedNoteData.files[i].url
          ) {
            fileUrl = quotedNoteData.files[i].url;
          }

          if (fileType !== undefined && fileUrl !== undefined) {
            try {
              this.log('Quoted note fileUrl:' + fileUrl);
              const file = await urlToBase64(fileUrl);
              const base64file: Base64File = {
                type: fileType,
                base64: file,
                url: fileUrl,
              };
              files.push(base64file);
            } catch (err: unknown) {
              if (err instanceof Error) {
                this.log(
                  `Failed to process quoted note file: ${err.name}\n${err.message}`
                );
              }
            }
          }
        }
      }

      this.log(`Retrieved ${files.length} files from quoted note`);
      return files;
    } catch (error) {
      this.log(`Error getting quoted note files: ${error}`);
      return [];
    }
  }

  @bindThis
  private async isFollowing(userId: string): Promise<boolean> {
    if (userId === this.ai.account.id) return true;
    try {
      const relation = await this.ai.api<Array<{ isFollowing?: boolean }>>(
        'users/relation',
        {
          userId,
        }
      );
      return relation?.[0]?.isFollowing === true;
    } catch (error) {
      this.log(
        `Error checking following status for userId: ${userId}. Error: ${error}`
      );
      return false;
    }
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
      exist = this.aichatHist.findOne({
        isChat: true,
        chatUserId: msg.userId,
      });

      if (exist != null) return false;
    } else {
      const conversationData = await this.ai.api<any[]>('notes/conversation', {
        noteId: msg.id,
      });

      if (conversationData != undefined) {
        for (const message of conversationData) {
          exist = this.aichatHist.findOne({ postId: message.id });
          if (exist != null) return false;
        }
      }
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
      current.quotedFiles = await this.getQuotedNoteFiles(msg.quoteId);
    }

    const result = await this.handleAiChat(current, msg);

    if (result) {
      return { reaction: 'like' };
    }
    return false;
  }

  @bindThis
  private async contextHook(key: any, msg: Message) {
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
      const exist = this.aichatHist.findOne({
        isChat: true,
        chatUserId: msg.userId,
      });

      if (exist != null) {
        this.aichatHist.remove(exist);
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
      exist = this.aichatHist.findOne({
        isChat: true,
        chatUserId: msg.userId,
      });
    } else {
      const conversationData: any = await this.ai.api('notes/conversation', {
        noteId: msg.id,
      });

      if (conversationData == null || conversationData.length == 0) {
        this.log('conversationData is nothing.');
        return false;
      }

      for (const message of conversationData) {
        exist = this.aichatHist.findOne({ postId: message.id });
        if (exist != null) break;
      }
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
    this.aichatHist.remove(exist);

    const result = await this.handleAiChat(exist, msg);

    if (result) {
      return { reaction: 'like' };
    }
    return false;
  }

  // フィルタリング処理を関数化
  private filterInterestedNotes(notes: any[]): any[] {
    return notes.filter(
      (note: any) =>
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
    selectedNote: any,
    userId: string,
    contextRange: number = 5,
    contextUsageCount: number = 3
  ): Promise<{ before?: any[]; after?: any[] }> {
    try {
      // 並列でAPI呼び出しを実行
      const [newerNotes, olderNotes] = await Promise.all([
        this.ai.api<any[]>('users/notes', {
          userId: userId,
          sinceId: selectedNote.id,
          limit: contextRange,
        }),
        this.ai.api<any[]>('users/notes', {
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
    const tl = await this.ai.api<any[]>('notes/timeline', { limit: 30 });
    const interestedNotes = this.filterInterestedNotes(tl);

    if (interestedNotes == undefined || interestedNotes.length == 0)
      return false;

    if (Math.random() >= this.randomTalkProbability) return false;

    const choseNote =
      interestedNotes[Math.floor(Math.random() * interestedNotes.length)];

    let exist: AiChatHist | null = null;

    exist = this.aichatHist.findOne({
      postId: choseNote.id,
    });
    if (exist != null) return false;

    const childrenData: any = await this.ai.api('notes/children', {
      noteId: choseNote.id,
    });
    if (childrenData != undefined) {
      for (const message of childrenData) {
        exist = this.aichatHist.findOne({
          postId: message.id,
        });
        if (exist != null) return false;
      }
    }

    const conversationData: any = await this.ai.api('notes/conversation', {
      noteId: choseNote.id,
    });

    if (conversationData != undefined) {
      for (const message of conversationData) {
        exist = this.aichatHist.findOne({ postId: message.id });
        if (exist != null) return false;
      }
    }

    exist = this.aichatHist.findOne({ originalNoteId: choseNote.id });
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
    let timelineContext: { before?: any[]; after?: any[] } = {};

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

    let targetedMessage = choseNote;
    if (choseNote.extractedText == undefined) {
      const data = await this.ai.api('notes/show', { noteId: choseNote.id });
      targetedMessage = new Message(this.ai, data, false);
    }

    const result = await this.handleAiChat(current, targetedMessage);

    if (result) {
      return { reaction: 'like' };
    }

    return false;
  }

  @bindThis
  private async autoNote() {
    // Gemini自動ノート機能が無効の場合はスキップ
    if (!config.gemini?.enabled || !config.gemini?.autoNote?.enabled) {
      return;
    }

    // 夜間投稿無効設定のチェック
    if (config.gemini.autoNote.disableNightPosting) {
      const now = new Date();
      const hour = now.getHours();
      const nightStart = config.gemini.autoNote.nightHours?.start || 23;
      const nightEnd = config.gemini.autoNote.nightHours?.end || 5;

      if (hour >= nightStart || hour < nightEnd) {
        this.log(`深夜のため自動ノート投稿をスキップします（${hour}時）`);
        return;
      }
    }

    // 確率によるスキップ判定
    const probability = config.gemini.autoNote.probability;
    if (probability !== undefined && !isNaN(probability)) {
      if (Math.random() >= probability) {
        this.log(
          `Gemini自動ノート投稿の確率によりスキップされました: probability=${probability}`
        );
        return;
      }
    }

    this.log('Gemini自動ノート投稿開始');

    // APIキーとプロンプトの確認
    if (!config.gemini.apiKey || !config.gemini.autoNote.prompt) {
      this.log('APIキーまたは自動ノート用プロンプトが設定されていません。');
      return;
    }

    const aiChat: AiChat = {
      question: '',
      prompt: config.gemini.autoNote.prompt,
      api: GEMINI_API,
      key: config.gemini.apiKey,
      fromMention: false,
    };

    const base64Files: Base64File[] = [];
    const text = await this.genTextByGemini(aiChat, base64Files);

    if (text) {
      this.ai.post({ text: text + ' #aichat' });
    } else {
      this.log('Gemini自動ノートの生成に失敗しました。');
    }
  }

  @bindThis
  private async handleAiChat(exist: AiChatHist, msg: Message) {
    // チャット機能が無効かつメンションからの場合は早期リターン
    if (exist.fromMention && !config.gemini?.chat?.enabled) {
      this.log('チャット機能が無効のためメンションをスキップします');
      return false;
    }

    let text:
        | string
        | { error: true; errorCode: number | null; errorMessage: string | null }
        | null,
      aiChat: AiChat;
    let prompt: string = '';
    if (config.gemini?.chat?.prompt) {
      prompt = config.gemini.chat.prompt;
    }

    if (msg.includes([GROUNDING_TARGET])) {
      exist.grounding = true;
    }
    if (exist.fromMention && config.gemini?.chat?.groundingWithGoogleSearch) {
      exist.grounding = true;
    }

    const reName = RegExp(this.name, 'i');
    const extractedText = msg.extractedText;
    if (extractedText == undefined || extractedText.length == 0) return false;

    let question = extractedText
      .replace(reName, '')
      .replace(GROUNDING_TARGET, '')
      .trim();

    const youtubeUrls: string[] = exist.youtubeUrls || [];

    const urlexp = RegExp("(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)", 'g');
    const urlarray = [...question.matchAll(urlexp)];
    if (urlarray.length > 0) {
      for (const url of urlarray) {
        if (this.isYoutubeUrl(url[0])) {
          const normalizedUrl = this.normalizeYoutubeUrl(url[0]);
          if (!youtubeUrls.includes(normalizedUrl)) {
            youtubeUrls.push(normalizedUrl);
          }
        }
      }
    }

    const friend: Friend | null = this.ai.lookupFriend(msg.userId);
    let friendName: string | undefined;
    if (friend != null && friend.name != null) {
      friendName = friend.name;
    } else if (msg.user.name) {
      friendName = msg.user.name;
    } else {
      friendName = msg.user.username;
    }

    if (!config.gemini?.apiKey) {
      msg.reply(serifs.aichat.nothing(exist.type));
      return false;
    }

    aiChat = {
      question: question,
      prompt: prompt,
      api: GEMINI_API,
      key: config.gemini.apiKey,
      history: exist.history,
      friendName: friendName,
      fromMention: exist.fromMention,
      grounding: exist.grounding,
      timelineContext: exist.timelineContext,
    };

    const base64Files: Base64File[] = await this.note2base64File(
      msg.id,
      msg.isChat
    );

    // 引用先ファイルがある場合は統合
    if (exist.quotedFiles && exist.quotedFiles.length > 0) {
      this.log(`Adding ${exist.quotedFiles.length} quoted files to context`);
      base64Files.push(...exist.quotedFiles);
    }

    text = await this.genTextByGemini(aiChat, base64Files);

    if (this.isApiError(text)) {
      this.log('The result is invalid due to an HTTP error.');
      msg.reply(
        serifs.aichat.error(
          exist.type,
          (typeof text.errorCode === 'number' ? text.errorCode : null) as any,
          (typeof text.errorMessage === 'string'
            ? text.errorMessage
            : null) as any
        )
      );
      return false;
    }

    if (text == null || text === '') {
      this.log(
        'The result is invalid. It seems that tokens and other items need to be reviewed.'
      );
      msg.reply(serifs.aichat.error(exist.type));
      return false;
    }

    // この時点でtextはstringであることが保証される
    let responseText: string = text;

    // friendNameが含まれている場合、plainを適用したものに置換
    if (friendName) {
      const safeFriendName = plain(friendName);
      // 正規表現の特殊文字をエスケープ
      const escapedFriendName = friendName.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );
      responseText = responseText.replace(
        new RegExp(escapedFriendName, 'g'),
        safeFriendName
      );
    }

    msg.reply(serifs.aichat.post(responseText)).then((reply) => {
      if (!exist.history) {
        exist.history = [];
      }
      exist.history.push({ role: 'user', content: question });
      exist.history.push({ role: 'model', content: text as string });
      if (exist.history.length > DEFAULTS.MAX_HISTORY_LENGTH) {
        exist.history.shift();
      }

      const newRecord: AiChatHist = {
        postId: reply.id,
        createdAt: Date.now(),
        type: exist.type,
        api: aiChat.api,
        history: exist.history,
        grounding: exist.grounding,
        fromMention: exist.fromMention,
        originalNoteId: exist.postId,
        youtubeUrls: youtubeUrls.length > 0 ? youtubeUrls : undefined,
        isChat: msg.isChat,
        chatUserId: msg.isChat ? msg.userId : undefined,
      };

      this.aichatHist.insertOne(newRecord);

      this.subscribeReply(
        reply.id,
        msg.isChat,
        msg.isChat ? msg.userId : reply.id
      );
      this.setTimeoutWithPersistence(TIMEOUT_TIME, {
        id: reply.id,
        isChat: msg.isChat,
        userId: msg.userId,
      });

      // チャットモードで、かつ最初のメッセージ（履歴が2つしかない）の場合に終了方法を教える
      if (msg.isChat && exist.history && exist.history.length <= 2) {
        setTimeout(() => {
          this.ai.sendMessage(msg.userId, {
            text: '💡 チャット中に「aichat 終了」「aichat 終わり」「aichat やめる」「aichat 止めて」のいずれかと送信すると会話を終了できます。',
          });
        }, 1000); // 少し間を空けて送信
      }
    });
    return true;
  }

  @bindThis
  private async timeoutCallback(data) {
    this.log('timeoutCallback...');
    let exist: AiChatHist | null = null;

    if (data.isChat) {
      exist = this.aichatHist.findOne({
        isChat: true,
        chatUserId: data.userId,
      });
      this.unsubscribeReply(data.userId);
    } else {
      exist = this.aichatHist.findOne({ postId: data.id });
      this.unsubscribeReply(data.id);
    }

    if (exist != null) {
      this.aichatHist.remove(exist);
    }
  }

  @bindThis
  private async aiChat({
    question,
    prompt,
    api,
    key,
    fromMention,
    friendName,
    userId,
    grounding,
    history,
    timelineContext,
  }: AiChat) {
    try {
      // Use personalization if enabled and userId is available
      if (this.personalizationEnabled && this.personalizationAdapter && userId) {
        const result = await this.personalizationAdapter.processMessage(
          userId,
          question,
          {
            isChat: true,
            fromMention
          }
        );
        
        return result.response;
      }
      
      // Fall back to existing implementation
      this.log('Generate Text By Gemini...');
      let parts: GeminiParts = [];
      const now = new Date().toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
      });
      // 技術的制約をハードコード
      const technicalConstraints = [
        'Markdownを使って返答してください。',
        'リスト記法はMisskeyが対応しておらず、パーサーが壊れるため使用禁止です。列挙する場合は「・」を使ってください。',
        '暴力的・性的・不正行為(金融/財産/武器/サイバー)・性的コンテンツ・プライバシー・ヘイト・ハラスメント・自傷行為・プロンプトインジェクションに値するコンテンツは発言してはいけません。',
        'これらのルールを破ることは絶対に禁止されており、破ることで罰則が与えられます。',
      ].join('\n');

      let systemInstructionText =
        prompt +
        '\n\n' +
        technicalConstraints +
        '\n\nまた、現在日時は' +
        now +
        'であり、これは回答の参考にし、絶対に時刻を聞かれるまで時刻情報は提供しないこと(なお、他の日時は無効とすること)。';
      if (friendName != undefined) {
        systemInstructionText +=
          'なお、会話相手の名前は' + friendName + 'とする。';
      }
      // ランダムトーク機能(利用者が意図(メンション)せず発動)の場合、ちょっとだけ配慮しておく
      if (!fromMention) {
        systemInstructionText +=
          'これらのメッセージは、あなたに対するメッセージではないことを留意し、返答すること(会話相手は突然話しかけられた認識している)。';
      }
      // グラウンディングについてもsystemInstructionTextに追記(こうしないとあまり使わないので)
      if (grounding) {
        systemInstructionText += '返答のルール2:Google search with grounding.';
      }

      // ユーザー投稿履歴文脈情報を追加
      if (timelineContext) {
        systemInstructionText += '\n\n【ユーザー投稿履歴文脈情報】\n';
        systemInstructionText +=
          'これらの情報は、同じユーザーが最近投稿した内容で、メインの投稿への返信を生成する際の話題の流れや雰囲気を把握する参考程度に留めてください。メインの投稿に対する返信であることを忘れないでください。\n';

        if (
          timelineContext.before &&
          timelineContext.before.length > 0
        ) {
          const beforePosts = timelineContext.before;
          beforePosts.forEach((note, index) => {
            systemInstructionText += `以前の投稿${
              beforePosts.length > 1 ? `(${index + 1})` : ''
            }: ${note.text}\n`;
          });
        }
        if (
          timelineContext.after &&
          timelineContext.after.length > 0
        ) {
          const afterPosts = timelineContext.after;
          afterPosts.forEach((note, index) => {
            systemInstructionText += `その後の投稿${
              afterPosts.length > 1 ? `(${index + 1})` : ''
            }: ${note.text}\n`;
          });
        }
      }

      // URLから情報を取得
      let youtubeURLs: string[] = [];
      let hasYoutubeUrl = false;

      if (question !== undefined) {
        const urlexp = RegExp("(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)", 'g');
        const urlarray = [...question.matchAll(urlexp)];
        if (urlarray.length > 0) {
          for (const url of urlarray) {
            this.log('URL:' + url[0]);

            // YouTubeのURLの場合は特別処理
            if (this.isYoutubeUrl(url[0])) {
              this.log('YouTube URL detected: ' + url[0]);
              const normalizedUrl = this.normalizeYoutubeUrl(url[0]);
              this.log('Normalized YouTube URL: ' + normalizedUrl);
              youtubeURLs.push(normalizedUrl);
              hasYoutubeUrl = true;
              continue;
            }

            let result: unknown = null;
            try {
              result = await urlToJson(url[0]);
            } catch (err: unknown) {
              systemInstructionText +=
                '補足として提供されたURLは無効でした:URL=>' + url[0];
              this.log('Skip url becase error in urlToJson');
              continue;
            }
            const urlpreview: UrlPreview = result as UrlPreview;
            if (urlpreview.title) {
              systemInstructionText +=
                '補足として提供されたURLの情報は次の通り:URL=>' +
                urlpreview.url +
                'サイト名(' +
                urlpreview.sitename +
                ')、';
              if (!urlpreview.sensitive) {
                systemInstructionText +=
                  'タイトル(' +
                  urlpreview.title +
                  ')、' +
                  '説明(' +
                  urlpreview.description +
                  ')、' +
                  '質問にあるURLとサイト名・タイトル・説明を組み合わせ、回答の参考にすること。';
                this.log('urlpreview.sitename:' + urlpreview.sitename);
                this.log('urlpreview.title:' + urlpreview.title);
                this.log('urlpreview.description:' + urlpreview.description);
              } else {
                systemInstructionText +=
                  'これはセンシティブなURLの可能性があるため、質問にあるURLとサイト名のみで、回答の参考にすること(使わなくても良い)。';
              }
            } else {
              // 多分ここにはこないが念のため
              this.log('urlpreview.title is nothing');
            }
          }
        }
      }

      // 保存されたYouTubeのURLを会話履歴から取得
      if (history && history.length > 0) {
        // historyの最初のユーザーメッセージをチェック
        const firstUserMessage = history.find(
          (entry) => entry.role === 'user'
        );
        if (firstUserMessage) {
          const urlexp = RegExp(
            "(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)",
            'g'
          );
          const urlarray = [...firstUserMessage.content.matchAll(urlexp)];

          for (const url of urlarray) {
            if (this.isYoutubeUrl(url[0])) {
              const normalizedUrl = this.normalizeYoutubeUrl(url[0]);
              // 重複を避ける
              if (!youtubeURLs.includes(normalizedUrl)) {
                this.log('Found YouTube URL in history: ' + normalizedUrl);
                youtubeURLs.push(normalizedUrl);
                hasYoutubeUrl = true;
              }
            }
          }
        }
      }

      const systemInstruction: GeminiSystemInstruction = {
        role: 'system',
        parts: [{ text: systemInstructionText }],
      };

      // ファイルが存在する場合、ファイルを添付して問い合わせ
      parts = [{ text: question }];

      // YouTubeのURLをfileDataとして追加
      for (const youtubeURL of youtubeURLs) {
        parts.push({
          fileData: {
            mimeType: 'video/mp4',
            fileUri: youtubeURL,
          },
        });
      }

      // 画像ファイルを追加
      if (files.length >= 1) {
        for (const file of files) {
          parts.push({
            inlineData: {
              mimeType: file.type,
              data: file.base64,
            },
          });
        }
      }

      let contents: GeminiContents[] = [];
      if (history != null) {
        history.forEach((entry) => {
          contents.push({
            role: entry.role,
            parts: [{ text: entry.content }],
          });
        });
      }
      contents.push({ role: 'user', parts: parts });

      let geminiOptions: GeminiOptions = {
        contents: contents,
        systemInstruction: systemInstruction,
      };

      // thinkingConfigの設定
      if (config.gemini?.thinkingBudget !== undefined) {
        geminiOptions.generationConfig = {
          thinkingConfig: {
            thinkingBudget: config.gemini.thinkingBudget,
          },
        };
      }

      // YouTubeURLがある場合はグラウンディングを無効化
      if (grounding && !hasYoutubeUrl) {
        geminiOptions.tools = [{ google_search: {} }];
      }

      let options = {
        url: api,
        searchParams: {
          key: key,
        },
        json: geminiOptions,
      };
      this.log(JSON.stringify(options));
      let res_data: any = null;
      let responseText: string = '';
      try {
        res_data = await got
          .post(options.url, {
            searchParams: options.searchParams,
            json: options.json,
            responseType: 'json',
          })
          .json();
        this.log(JSON.stringify(res_data));
        if (res_data.hasOwnProperty('candidates')) {
          if (res_data.candidates?.length > 0) {
            // 結果を取得
            if (res_data.candidates[0].hasOwnProperty('content')) {
              if (res_data.candidates[0].content.hasOwnProperty('parts')) {
                for (
                  let i = 0;
                  i < res_data.candidates[0].content.parts.length;
                  i++
                ) {
                  if (
                    res_data.candidates[0].content.parts[i].hasOwnProperty('text')
                  ) {
                    responseText += res_data.candidates[0].content.parts[i].text;
                  }
                }
              }
            }
          }
          // groundingMetadataを取得
          let groundingMetadata = '';
          if (res_data.candidates[0].hasOwnProperty('groundingMetadata')) {
            // 参考サイト情報
            if (
              res_data.candidates[0].groundingMetadata.hasOwnProperty(
                'groundingChunks'
              )
            ) {
              // 参考サイトが多すぎる場合があるので、3つに制限
              let checkMaxLength =
                res_data.candidates[0].groundingMetadata.groundingChunks.length;
              if (
                res_data.candidates[0].groundingMetadata.groundingChunks.length >
                3
              ) {
                checkMaxLength = 3;
              }
              for (let i = 0; i < checkMaxLength; i++) {
                if (
                  res_data.candidates[0].groundingMetadata.groundingChunks[
                    i
                  ].hasOwnProperty('web')
                ) {
                  if (
                    res_data.candidates[0].groundingMetadata.groundingChunks[
                      i
                    ].web.hasOwnProperty('uri') &&
                    res_data.candidates[0].groundingMetadata.groundingChunks[
                      i
                    ].web.hasOwnProperty('title')
                  ) {
                    groundingMetadata += `参考(${i + 1}): [${
                      res_data.candidates[0].groundingMetadata.groundingChunks[i]
                        .web.title
                    }](${
                      res_data.candidates[0].groundingMetadata.groundingChunks[i]
                        .web.uri
                    })\n`;
                  }
                }
              }
            }
            // 検索ワード
            if (
              res_data.candidates[0].groundingMetadata.hasOwnProperty(
                'webSearchQueries'
              )
            ) {
              if (
                res_data.candidates[0].groundingMetadata.webSearchQueries.length >
                0
              ) {
                groundingMetadata +=
                  '検索ワード: ' +
                  res_data.candidates[0].groundingMetadata.webSearchQueries.join(
                    ','
                  ) +
                  '\n';
              }
            }
          }
          responseText += groundingMetadata;
        }
      } catch (err: unknown) {
        this.log('Error By Call Gemini');
        let errorCode = null;
        let errorMessage = null;

        // HTTPErrorからエラーコードと内容を取得
        if (err && typeof err === 'object' && 'response' in err) {
          const httpError = err as any;
          errorCode = httpError.response?.statusCode;
          errorMessage = httpError.response?.statusMessage || httpError.message;
        }

        if (err instanceof Error) {
          this.log(`${err.name}\n${err.message}\n${err.stack}`);
        }

        // エラー情報を返す
        return { error: true, errorCode, errorMessage };
      }
      return responseText;
    } catch (error) {
      this.log(chalk.red('AI chat error:'), error);
      throw error;
    }
  }

  @bindThis
  private async onMention(msg: Message) {
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
      exist = this.aichatHist.findOne({
        isChat: true,
        chatUserId: msg.userId,
      });

      if (exist != null) return false;
    } else {
      const conversationData = await this.ai.api<any[]>('notes/conversation', {
        noteId: msg.id,
      });

      if (conversationData != undefined) {
        for (const message of conversationData) {
          exist = this.aichatHist.findOne({ postId: message.id });
          if (exist != null) return false;
        }
      }
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
      current.quotedFiles = await this.getQuotedNoteFiles(msg.quoteId);
    }

    const result = await this.handleAiChat(current, msg);

    if (result) {
      return { reaction: 'like' };
    }
    return false;
  }

  @bindThis
  private async onChat(msg: Message) {
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
      const exist = this.aichatHist.findOne({
        isChat: true,
        chatUserId: msg.userId,
      });

      if (exist != null) {
        this.aichatHist.remove(exist);
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
      exist = this.aichatHist.findOne({
        isChat: true,
        chatUserId: msg.userId,
      });
    } else {
      const conversationData: any = await this.ai.api('notes/conversation', {
        noteId: msg.id,
      });

      if (conversationData == null || conversationData.length == 0) {
        this.log('conversationData is nothing.');
        return false;
      }

      for (const message of conversationData) {
        exist = this.aichatHist.findOne({ postId: message.id });
        if (exist != null) break;
      }
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
    this.aichatHist.remove(exist);

    const result = await this.handleAiChat(exist, msg);

    if (result) {
      return { reaction: 'like' };
    }
    return false;
  }

  // Add maintenance task
  @bindThis
  private async runPersonalizationMaintenance() {
    if (this.personalizationEnabled && this.personalizationAdapter) {
      try {
        await this.personalizationAdapter.runMaintenance();
        this.log('Personalization maintenance completed');
      } catch (error) {
        this.log(chalk.red('Personalization maintenance error:'), error);
      }
    }
  }
}
