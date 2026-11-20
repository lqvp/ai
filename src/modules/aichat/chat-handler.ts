import type 藍 from '@/ai.js';
import config from '@/config/index.js';
import type Friend from '@/friend.js';
import type Message from '@/message.js';
import serifs from '@/serifs.js';
import { fetchNoteFiles } from '@/services/media.js';
import { plain } from '@/utils/mfm.js';
import {
  DEFAULTS,
  GROUNDING_TARGET,
  getGeminiApiUrl,
  TIMEOUT_TIME,
} from './constants.js';
import type {
  AiChatHist,
  ChatHistoryRepository,
} from './history-repository.js';
import { resolveOpenaiSettings } from './openai-settings.js';
import { stripReactionMarker } from './reaction-marker.js';
import type { AiChat, Base64File } from './types.js';
import {
  extractUrls,
  isYoutubeUrl,
  normalizeYoutubeUrl,
} from './url-context.js';

export type GenerateText = (
  aiChat: AiChat,
  files: Base64File[],
  msg?: Message
) => Promise<
  | string
  | { error: true; errorCode?: number | null; errorMessage?: string | null }
  | null
>;

export type ChatHandlerDeps = {
  ai: 藍;
  moduleName: string;
  history: ChatHistoryRepository;
  log: (message: string) => void;
  genText: GenerateText;
  subscribeReply: (postId: string, isChat: boolean, userId: string) => void;
  setTimeoutWithPersistence: (delay: number, data: unknown) => void;
  later: (ms: number, task: () => unknown) => void;
  /** エピソード記憶の回想コンテキストを組み立てる（無効時は未指定） */
  buildMemoryRecallContext?: (userId: string) => string;
  /** 現在の気分を演技コンテキストとして組み立てる（無効時は未指定） */
  buildMoodContext?: () => string;
  /** LLMが選んだリアクションをコアへ伝える（無効時は未指定） */
  registerReactionChoice?: (noteId: string, reaction: string | null) => void;
};

/**
 * メンション / チャット1件に対する返信生成〜投稿を担当する。
 *
 * もとは `aichat/index.ts` の `handleAiChat`（約190行）で、
 * モジュールのフックやタイマーと混ざっていた。
 */
export class ChatHandler {
  constructor(private readonly deps: ChatHandlerDeps) {}

  public async handle(exist: AiChatHist, msg: Message): Promise<boolean> {
    const { ai, history, log } = this.deps;

    // チャット機能が無効かつメンションからの場合は早期リターン
    if (exist.fromMention && !config.gemini?.chat?.enabled) {
      log('チャット機能が無効のためメンションをスキップします');
      return false;
    }

    let prompt = '';
    if (config.gemini?.chat?.prompt) {
      prompt = config.gemini.chat.prompt;
    }

    if (msg.includes([GROUNDING_TARGET])) {
      exist.grounding = true;
    }
    if (exist.fromMention && config.gemini?.chat?.groundingWithGoogleSearch) {
      exist.grounding = true;
    }

    const extractedText = msg.extractedText;
    if (extractedText == undefined || extractedText.length == 0) return false;

    const question = extractedText
      .replace(new RegExp(this.deps.moduleName, 'i'), '')
      .replace(GROUNDING_TARGET, '')
      .trim();

    const youtubeUrls: string[] = exist.youtubeUrls || [];
    for (const url of extractUrls(question)) {
      if (isYoutubeUrl(url)) {
        const normalizedUrl = normalizeYoutubeUrl(url, log);
        if (!youtubeUrls.includes(normalizedUrl)) {
          youtubeUrls.push(normalizedUrl);
        }
      }
    }

    const friend: Friend | null = ai.lookupFriend(msg.userId);
    let friendName: string;
    if (friend != null && friend.name != null) {
      friendName = friend.name;
    } else if (msg.user.name) {
      friendName = msg.user.name;
    } else {
      friendName = msg.user.username;
    }

    const provider = config.aiProvider?.provider || 'gemini';
    // OpenAI 互換 API はキー不要のエンドポイントがあり得るため、
    // apiKey は任意扱いで設定を解決する
    const openaiSettings =
      provider === 'openai' ? resolveOpenaiSettings() : null;
    const apiKey = openaiSettings
      ? openaiSettings.apiKey || ''
      : config.gemini?.apiKey || '';

    if (!openaiSettings && !apiKey) {
      msg.reply(serifs.aichat.nothing(exist.type));
      return false;
    }

    const apiUrl = openaiSettings ? openaiSettings.apiUrl : getGeminiApiUrl();

    const aiChat: AiChat = {
      question,
      prompt,
      api: apiUrl,
      key: apiKey || '',
      history: exist.history,
      friendName,
      fromMention: exist.fromMention,
      grounding: exist.grounding,
      timelineContext: exist.timelineContext,
      // エピソード記憶の回想コンテキスト（重要度4以上のみ・上限2000字）
      memoryRecallContext: this.deps.buildMemoryRecallContext?.(msg.userId),
      // 現在の気分の演技コンテキスト（気分エンジン有効時のみ）
      moodContext: this.deps.buildMoodContext?.(),
      // パーソナライズドリアクション: メイン生成にマーカー出力を同居させる
      reactionMarkerEnabled:
        config.aichat?.moodEngine?.reactionPersonalization !== false,
    };

    const base64Files: Base64File[] = msg.isChat
      ? []
      : await fetchNoteFiles(ai.api, msg.id, { log });

    // 引用先ファイルがある場合は統合
    if (exist.quotedFiles && exist.quotedFiles.length > 0) {
      log(`Adding ${exist.quotedFiles.length} quoted files to context`);
      base64Files.push(...exist.quotedFiles);
    }

    const text = await this.deps.genText(aiChat, base64Files, msg);

    if (text != null && typeof text === 'object') {
      log('The result is invalid due to an HTTP error.');
      msg.reply(
        serifs.aichat.error(
          exist.type,
          typeof text.errorCode === 'number' ? text.errorCode : null,
          typeof text.errorMessage === 'string' ? text.errorMessage : null
        )
      );
      return false;
    }

    if (text == null || text === '') {
      log(
        'The result is invalid. It seems that tokens and other items need to be reviewed.'
      );
      msg.reply(serifs.aichat.error(exist.type));
      return false;
    }

    let responseText: string = text;

    // パーソナライズドリアクション: 応答末尾の [[REACTION: ...]] を
    // 投稿前に剥がし、リアクション選択としてコアへ渡す。
    // 無効時もマーカーが紛れ込んだ場合に備えて常に剥がす。
    const { reaction, markerFound, cleaned } =
      stripReactionMarker(responseText);
    responseText = cleaned;
    // マーカーが無い応答は「未選択」として扱い、既定の like へフォールバックさせる
    if (markerFound) {
      this.deps.registerReactionChoice?.(msg.id, reaction);
    }

    // friendName が含まれている場合、plain を適用したものに置換
    if (friendName) {
      const safeFriendName = plain(friendName);
      const escapedFriendName = friendName.replace(
        /[.*+?^${}()|[\]\\]/g,
        '\\$&'
      );
      responseText = responseText.replace(
        new RegExp(escapedFriendName, 'g'),
        safeFriendName
      );
    }

    const historyItems = exist.history || [];

    msg.reply(serifs.aichat.post(responseText)).then((reply) => {
      historyItems.push({ role: 'user', content: question });
      historyItems.push({ role: 'model', content: text as string });
      while (historyItems.length > DEFAULTS.MAX_HISTORY_LENGTH) {
        historyItems.shift();
      }
      exist.history = historyItems;

      history.insert({
        postId: reply.id,
        createdAt: Date.now(),
        type: exist.type,
        api: aiChat.api,
        history: historyItems,
        grounding: exist.grounding,
        fromMention: exist.fromMention,
        originalNoteId: exist.postId,
        youtubeUrls: youtubeUrls.length > 0 ? youtubeUrls : undefined,
        isChat: msg.isChat,
        chatUserId: msg.isChat ? msg.userId : undefined,
      });

      this.deps.subscribeReply(
        reply.id,
        msg.isChat,
        msg.isChat ? msg.userId : reply.id
      );
      this.deps.setTimeoutWithPersistence(TIMEOUT_TIME, {
        id: reply.id,
        isChat: msg.isChat,
        userId: msg.userId,
      });

      // チャットモードで、かつ最初のメッセージ（履歴が2つしかない）の場合に終了方法を教える
      if (msg.isChat && historyItems.length <= 2) {
        this.deps.later(1000, () => {
          ai.sendMessage(msg.userId, {
            text: '💡 チャット中に「aichat 終了」「aichat 終わり」「aichat やめる」「aichat 止めて」のいずれかと送信すると会話を終了できます。',
          });
        });
      }
    });

    return true;
  }
}
