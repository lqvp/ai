import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import Message from '@/message.js';
import config from '@/config.js';
import Friend from '@/friend.js';
import urlToBase64 from '@/utils/url2base64.js';
import urlToJson from '@/utils/url2json.js';
import { GeminiResponse, generateText } from '@/utils/gemini.js';
import got from 'got';
import loki from 'lokijs';

type AiChat = {
  question: string;
  prompt: string;
  api: string;
  key: string;
  fromMention: boolean;
  friendName?: string;
  grounding?: boolean;
  history?: { role: string; content: string }[];
  youtubeUrls?: string[];
};
type base64File = {
  type: string;
  base64: string;
  url?: string;
};
type GeminiOptions = {
  contents?: GeminiContents[];
  systemInstruction?: GeminiSystemInstruction;
  tools?: [{}];
};
type GeminiParts = {
  inlineData?: {
    mimeType: string;
    data: string;
  };
  fileData?: {
    mimeType: string;
    fileUri: string;
  };
  text?: string;
}[];
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
  history?: {
    role: string;
    content: string;
  }[];
  friendName?: string;
  originalNoteId?: string;
  fromMention: boolean;
  grounding?: boolean;
  youtubeUrls?: string[]; // YouTubeのURLを保存するための配列を追加
  isChat?: boolean; // チャットメッセージかどうかを示すフラグを追加
  chatUserId?: string; // チャットの場合、ユーザーIDを保存
};

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

const TYPE_GEMINI = 'gemini';
const geminiModel = config.geminiModel || 'gemini-2.0-flash-exp';
const GEMINI_API = `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent`;
const GROUNDING_TARGET = 'ggg';

const RANDOMTALK_DEFAULT_PROBABILITY = 0.02; // デフォルトのrandomTalk確率
const TIMEOUT_TIME = 1000 * 60 * 60 * 0.5; // aichatの返信を監視する時間
const RANDOMTALK_DEFAULT_INTERVAL = 1000 * 60 * 60 * 12; // デフォルトのrandomTalk間隔

const AUTO_NOTE_DEFAULT_INTERVAL = 1000 * 60 * 360;
const AUTO_NOTE_DEFAULT_PROBABILITY = 0.02;

export default class extends Module {
  public readonly name = 'aichat';
  private aichatHist: loki.Collection<AiChatHist>;
  private randomTalkProbability: number = RANDOMTALK_DEFAULT_PROBABILITY;
  private randomTalkIntervalMinutes: number = RANDOMTALK_DEFAULT_INTERVAL;

  @bindThis
  public install() {
    this.aichatHist = this.ai.getCollection('aichatHist', {
      indices: ['postId', 'originalNoteId'],
    });

    if (
      config.aichatRandomTalkProbability != undefined &&
      !Number.isNaN(
        Number.parseFloat(String(config.aichatRandomTalkProbability))
      )
    ) {
      this.randomTalkProbability = Number.parseFloat(
        String(config.aichatRandomTalkProbability)
      );
    }
    if (
      config.aichatRandomTalkIntervalMinutes != undefined &&
      !Number.isNaN(
        Number.parseInt(String(config.aichatRandomTalkIntervalMinutes))
      )
    ) {
      this.randomTalkIntervalMinutes =
        1000 *
        60 *
        Number.parseInt(String(config.aichatRandomTalkIntervalMinutes));
    }
    this.log('aichatRandomTalkEnabled:' + config.aichatRandomTalkEnabled);
    this.log('randomTalkProbability:' + this.randomTalkProbability);
    this.log(
      'randomTalkIntervalMinutes:' +
        this.randomTalkIntervalMinutes / (60 * 1000)
    );
    this.log(
      'aichatGroundingWithGoogleSearchAlwaysEnabled:' +
        config.aichatGroundingWithGoogleSearchAlwaysEnabled
    );

    if (config.aichatRandomTalkEnabled) {
      setInterval(this.aichatRandomTalk, this.randomTalkIntervalMinutes);
    }

    // ここで geminiPostMode が "auto" もしくは "both" の場合、自動ノート投稿を設定
    if (config.geminiPostMode === 'auto' || config.geminiPostMode === 'both') {
      const interval =
        config.autoNoteIntervalMinutes != undefined &&
        !isNaN(parseInt(String(config.autoNoteIntervalMinutes)))
          ? 1000 * 60 * parseInt(String(config.autoNoteIntervalMinutes))
          : AUTO_NOTE_DEFAULT_INTERVAL;
      setInterval(this.autoNote, interval);
      this.log('Gemini自動ノート投稿を有効化: interval=' + interval);
      const probability =
        config.geminiAutoNoteProbability &&
        !isNaN(parseFloat(String(config.geminiAutoNoteProbability)))
          ? parseFloat(String(config.geminiAutoNoteProbability))
          : AUTO_NOTE_DEFAULT_PROBABILITY;
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
  private async genTextByGemini(aiChat: AiChat, files: base64File[]): Promise<string | GeminiResponse> {
    this.log('Generate Text By Gemini...');
    const result = await generateText(
      aiChat.question,
      aiChat.prompt,
      aiChat.history,
      aiChat.friendName,
      aiChat.fromMention,
      aiChat.grounding,
      files,
      aiChat.youtubeUrls || []
    );

    if (result.error) {
      return result;
    }

    return result.text;
  }

  @bindThis
  private async note2base64File(notesId: string, isChat: boolean) {
    // チャットメッセージの場合は画像取得をスキップ
    if (isChat) {
      return [];
    }

    const noteData = await this.ai.api('notes/show', { noteId: notesId });
    let files: base64File[] = [];
    if (noteData !== null && noteData.hasOwnProperty('files')) {
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
            const base64file: base64File = { type: fileType, base64: file };
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
  private async mentionHook(msg: Message) {
    if (!msg.includes([this.name])) {
      return false;
    } else {
      this.log('AiChat requested');

      const relation = await this.ai?.api('users/relation', {
        userId: msg.userId,
      });

      if (relation[0]?.isFollowing !== true) {
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
      const conversationData = await this.ai.api('notes/conversation', {
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
      const quotedNote = await this.ai.api('notes/show', {
        noteId: msg.quoteId,
      });
      current.history = [
        {
          role: 'user',
          content:
            'ユーザーが与えた前情報である、引用された文章: ' + quotedNote.text,
        },
      ];
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
      const conversationData = await this.ai.api('notes/conversation', {
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

    const relation = await this.ai.api('users/relation', {
      userId: msg.userId,
    });
    if (relation[0]?.isFollowing !== true) {
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

  @bindThis
  private async aichatRandomTalk() {
    this.log('AiChat(randomtalk) started');
    const tl = await this.ai.api('notes/timeline', { limit: 30 });
    const interestedNotes = tl.filter(
      (note) =>
        note.userId !== this.ai.account.id &&
        note.text != null &&
        note.replyId == null &&
        note.renoteId == null &&
        note.cw == null &&
        (note.visibility === 'public' || note.visibility === 'home') &&
        note.files.length == 0 &&
        !note.user.isBot
    );

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

    const childrenData = await this.ai.api('notes/children', {
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

    const conversationData = await this.ai.api('notes/conversation', {
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

    const relation = await this.ai.api('users/relation', {
      userId: choseNote.userId,
    });

    if (relation[0]?.isFollowing === true) {
      const current: AiChatHist = {
        postId: choseNote.id,
        createdAt: Date.now(),
        type: TYPE_GEMINI,
        fromMention: false,
      };

      let targetedMessage = choseNote;
      if (choseNote.extractedText == undefined) {
        const data = await this.ai.api('notes/show', { noteId: choseNote.id });
        targetedMessage = new Message(this.ai, data);
      }

      const result = await this.handleAiChat(current, targetedMessage);

      if (result) {
        return { reaction: 'like' };
      }
    }

    return false;
  }

  @bindThis
  private async autoNote() {
    if (config.autoNoteDisableNightPosting) {
      const now = new Date();
      const hour = now.getHours();
      if (hour >= 23 || hour < 5) {
        this.log('深夜のため自動ノート投稿をスキップします（' + hour + '時）');
        return;
      }
    }

    if (
      config.geminiAutoNoteProbability !== undefined &&
      !isNaN(Number.parseFloat(String(config.geminiAutoNoteProbability)))
    ) {
      const probability = Number.parseFloat(
        String(config.geminiAutoNoteProbability)
      );
      if (Math.random() >= probability) {
        this.log(
          `Gemini自動ノート投稿の確率によりスキップされました: probability=${probability}`
        );
        return;
      }
    }
    this.log('Gemini自動ノート投稿開始');
    if (!config.geminiApiKey || !config.autoNotePrompt) {
      this.log('APIキーまたは自動ノート用プロンプトが設定されていません。');
      return;
    }
    const aiChat: AiChat = {
      question: '',
      prompt: config.autoNotePrompt,
      api: GEMINI_API,
      key: config.geminiApiKey,
      fromMention: false,
    };
    const base64Files: base64File[] = [];
    const text = await this.genTextByGemini(aiChat, base64Files);
    if (text) {
      this.ai.post({ text: text + ' #aichat' });
    } else {
      this.log('Gemini自動ノートの生成に失敗しました。');
    }
  }

  @bindThis
  private async handleAiChat(exist: AiChatHist, msg: Message) {
    let text: string | null, aiChat: AiChat;
    let prompt: string = '';
    if (config.prompt) {
      prompt = config.prompt;
    }

    if (msg.includes([GROUNDING_TARGET])) {
      exist.grounding = true;
    }
    if (
      exist.fromMention &&
      config.aichatGroundingWithGoogleSearchAlwaysEnabled
    ) {
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

    if (!config.geminiApiKey) {
      msg.reply(serifs.aichat.nothing(exist.type));
      return false;
    }

    aiChat = {
      question: question,
      prompt: prompt,
      api: GEMINI_API,
      key: config.geminiApiKey,
      history: exist.history,
      friendName: friendName,
      fromMention: exist.fromMention,
      grounding: exist.grounding,
			youtubeUrls: youtubeUrls ?? [],
    };

    const base64Files: base64File[] = await this.note2base64File(
      msg.id,
      msg.isChat
    );
    text = await this.genTextByGemini(aiChat, base64Files);

    if (text && typeof text === 'object' && 'error' in text) {
      this.log('The result is invalid due to an HTTP error.');
      msg.reply(
        serifs.aichat.error(
          exist.type,
          (text as any).errorCode,
          (text as any).errorMessage
        )
      );
      return false;
    }

    if (text == null || text == '') {
      this.log(
        'The result is invalid. It seems that tokens and other items need to be reviewed.'
      );
      msg.reply(serifs.aichat.error(exist.type));
      return false;
    }

    msg.reply(serifs.aichat.post(text)).then((reply) => {
      if (!exist.history) {
        exist.history = [];
      }
      exist.history.push({ role: 'user', content: question });
      exist.history.push({ role: 'model', content: text });
      if (exist.history.length > 10) {
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
}
