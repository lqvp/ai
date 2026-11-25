import { randomUUID } from 'node:crypto';
import type 藍 from '@/ai.js';
import config from '@/config/index.js';
import type Friend from '@/friend.js';
import type Message from '@/message.js';
import type { User } from '@/misskey/types.js';
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
import { sanitizeFriendName } from './prompt-builder.js';
import { resolveProvider } from './structured-llm.js';
import type { AiChat, Base64File, ProviderDetailedResponse } from './types.js';
import {
  extractUrls,
  isYoutubeUrl,
  normalizeYoutubeUrl,
} from './url-context.js';

export type GenerateTextDetailed = (
  aiChat: AiChat,
  files: Base64File[],
  msg?: Message
) => Promise<ProviderDetailedResponse>;

export type ChatHandlerDeps = {
  ai: 藍;
  moduleName: string;
  history: ChatHistoryRepository;
  log: (message: string) => void;
  genTextDetailed: GenerateTextDetailed;
  subscribeReply: (
    key: string,
    isChat: boolean,
    id: string,
    data?: unknown
  ) => void;
  removeOldNoteContext?: (noteId: string) => void;
  later: (ms: number, task: () => unknown) => void;
  buildPlaybookText?: () => Promise<string>;
  buildAffinityContext?: (user: User, isMaster: boolean) => Promise<string>;
  now?: () => number;
};

export type ChatHandleResult =
  | { status: 'replied'; userText: string; isMaster: boolean }
  | { status: 'react_only'; userText: string; isMaster: boolean }
  | { status: 'ignored'; userText: string; isMaster: boolean }
  | { status: 'failed' };

const MAX_ACTIVE_POST_IDS = 3;

function cloneHistoryItems<T extends { role: string; content: string }>(
  items: T[]
): T[] {
  return items.map((item) => ({ ...item }));
}

/**
 * メンション / リプライ / チャット1件に対する返信生成〜投稿〜履歴コミットを担当する。
 */
export class ChatHandler {
  private readonly now: () => number;

  constructor(private readonly deps: ChatHandlerDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  public async handle(
    exist: AiChatHist,
    msg: Message
  ): Promise<ChatHandleResult> {
    const { ai, history, log } = this.deps;

    const explicitlyDisabledChat = config.gemini?.chat?.enabled === false;
    if (exist.fromMention && explicitlyDisabledChat) {
      log('チャット機能が無効のためメンションをスキップします');
      return { status: 'failed' };
    }

    const isMaster = ai.relationship.isMaster(msg.user);
    const allowWebTools =
      isMaster || config.aichat?.allowNonMasterWebTools === true;

    const prompt = config.gemini?.chat?.prompt ?? '';

    if (allowWebTools && msg.includes([GROUNDING_TARGET])) {
      exist.grounding = true;
    }
    if (
      allowWebTools &&
      exist.fromMention &&
      config.gemini?.chat?.groundingWithGoogleSearch
    ) {
      exist.grounding = true;
    }
    if (!allowWebTools) {
      exist.grounding = false;
    }

    // 先に添付ファイルを取得することで、テキスト無しの画像のみ投稿にも対応する
    const base64Files: Base64File[] = msg.isChat
      ? []
      : await fetchNoteFiles(ai.api, msg.id, { log });

    if (exist.quotedFiles && exist.quotedFiles.length > 0) {
      log(`Adding ${exist.quotedFiles.length} quoted files to context`);
      base64Files.push(...exist.quotedFiles);
    }

    const rawExtracted = msg.extractedText ?? '';
    const question = rawExtracted
      .replace(new RegExp(this.deps.moduleName, 'i'), '')
      .replace(GROUNDING_TARGET, '')
      .trim();

    if (question.length === 0 && base64Files.length === 0) {
      return { status: 'failed' };
    }

    const modelQuestion = question.length > 0 ? question : '(添付画像のみ)';

    const youtubeUrls: string[] = [...(exist.youtubeUrls ?? [])];
    if (allowWebTools) {
      for (const url of extractUrls(question)) {
        if (isYoutubeUrl(url)) {
          const normalizedUrl = normalizeYoutubeUrl(url, log);
          if (!youtubeUrls.includes(normalizedUrl)) {
            youtubeUrls.push(normalizedUrl);
          }
        }
      }
    }

    const friend: Friend | null = ai.lookupFriend(msg.userId);
    let rawFriendName: string;
    if (friend != null && friend.name != null) {
      rawFriendName = friend.name;
    } else if (msg.user.name) {
      rawFriendName = msg.user.name;
    } else {
      rawFriendName = msg.user.username;
    }
    const safeFriendName = sanitizeFriendName(rawFriendName);

    const provider = resolveProvider();
    const openaiSettings =
      provider === 'openai' ? resolveOpenaiSettings() : null;
    const apiKey = openaiSettings
      ? openaiSettings.apiKey || ''
      : config.gemini?.apiKey || '';

    const requiresOpenaiKey =
      openaiSettings != null &&
      openaiSettings.apiUrl.startsWith('https://api.openai.com');

    if ((!openaiSettings && !apiKey) || (requiresOpenaiKey && !apiKey)) {
      await msg
        .reply(serifs.aichat.nothing(exist.type))
        .catch((err) => log(`Missing key reply failed: ${String(err)}`));
      return { status: 'failed' };
    }

    const apiUrl = openaiSettings ? openaiSettings.apiUrl : getGeminiApiUrl();

    const [playbookText, affinityContext] = await Promise.all([
      this.deps.buildPlaybookText?.() ?? Promise.resolve(''),
      this.deps.buildAffinityContext?.(msg.user, isMaster) ??
        Promise.resolve(''),
    ]);

    const aiChat: AiChat = {
      question: modelQuestion,
      prompt,
      api: apiUrl,
      key: apiKey || '',
      history: exist.history,
      friendName: safeFriendName || undefined,
      fromMention: exist.fromMention,
      grounding: exist.grounding,
      timelineContext: exist.timelineContext,
      playbookText,
      affinityContext,
      allowWebTools,
      allowSentinels: true,
    };

    const result = await this.deps.genTextDetailed(aiChat, base64Files, msg);

    if (result != null && 'error' in result) {
      log('The result is invalid due to an HTTP error.');
      await msg
        .reply(
          serifs.aichat.error(
            exist.type,
            typeof result.errorCode === 'number' ? result.errorCode : null,
            typeof result.errorMessage === 'string' ? result.errorMessage : null
          )
        )
        .catch((err) => log(`Error reply failed: ${String(err)}`));
      return { status: 'failed' };
    }

    if (result == null || result.text.trim() === '') {
      log(
        'The result is invalid. It seems that tokens and other items need to be reviewed.'
      );
      await msg
        .reply(serifs.aichat.error(exist.type))
        .catch((err) => log(`Empty reply notification failed: ${String(err)}`));
      return { status: 'failed' };
    }

    const cleanModelText = result.text.trim();

    if (cleanModelText === '[[IGNORE]]') {
      return { status: 'ignored', userText: question, isMaster };
    }
    if (cleanModelText === '[[REACT_ONLY]]') {
      return { status: 'react_only', userText: question, isMaster };
    }

    let displayText = cleanModelText;
    if (safeFriendName) {
      const escaped = safeFriendName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      displayText = displayText.replace(
        new RegExp(escaped, 'g'),
        plain(safeFriendName)
      );
    }

    const shouldAppendHashtag =
      exist.fromMention && !msg.isChat && !exist.isFallbackMention;
    let outgoingText = shouldAppendHashtag
      ? serifs.aichat.post(displayText)
      : displayText;

    const suffix = result.metadataSuffix.trim();
    if (suffix !== '') {
      outgoingText = `${outgoingText}\n${suffix}`;
    }

    let replyNote: { id: string } | undefined;
    try {
      replyNote = (await msg.reply(outgoingText)) as { id: string } | undefined;
    } catch (err: unknown) {
      log(
        `返信投稿に失敗しました（履歴は保持します）: ${err instanceof Error ? err.message : String(err)}`
      );
      return { status: 'failed' };
    }

    const replyId = replyNote?.id ?? randomUUID();
    const nowMs = this.now();
    const historyItems = [...(exist.history ?? [])];
    historyItems.push({ role: 'user', content: modelQuestion });
    historyItems.push({ role: 'model', content: cleanModelText });
    while (historyItems.length > DEFAULTS.MAX_HISTORY_LENGTH) {
      historyItems.shift();
    }

    const sessionId = exist.sessionId ?? randomUUID();
    const prevPostIds = exist.postIds ?? (exist.postId ? [exist.postId] : []);
    const nextPostIds = [...prevPostIds, replyId];
    while (nextPostIds.length > MAX_ACTIVE_POST_IDS) {
      const evictedId = nextPostIds.shift();
      if (evictedId && !msg.isChat) {
        this.deps.removeOldNoteContext?.(evictedId);
      }
    }

    const nextSnapshots: NonNullable<AiChatHist['historySnapshots']> = {};
    for (const postId of nextPostIds) {
      const snapshot = exist.historySnapshots?.[postId];
      if (snapshot) nextSnapshots[postId] = cloneHistoryItems(snapshot);
    }
    nextSnapshots[replyId] = cloneHistoryItems(historyItems);

    exist.sessionId = sessionId;
    exist.postId = replyId;
    exist.latestPostId = replyId;
    exist.postIds = nextPostIds;
    exist.updatedAt = nowMs;
    exist.expiresAt = nowMs + TIMEOUT_TIME;
    exist.api = aiChat.api;
    exist.history = historyItems;
    exist.historySnapshots = nextSnapshots;
    exist.youtubeUrls = youtubeUrls.length > 0 ? youtubeUrls : undefined;
    exist.isChat = msg.isChat;
    exist.chatUserId = msg.isChat ? msg.userId : undefined;
    exist.ownerUserId = exist.ownerUserId ?? msg.userId;
    exist.quotedFiles = undefined;

    if (history.findBySessionId(sessionId)) {
      history.update(exist);
    } else {
      history.insert(exist);
    }

    this.deps.subscribeReply(
      sessionId,
      msg.isChat,
      msg.isChat ? msg.userId : replyId,
      {
        sessionId,
        historyLength: historyItems.length,
      }
    );

    if (msg.isChat && historyItems.length <= 2) {
      this.deps.later(1000, () => {
        void Promise.resolve(
          ai.sendMessage(msg.userId, {
            text: '💡 チャット中に「aichat 終了」「aichat 終わり」「aichat やめる」「aichat 止めて」のいずれかと送信すると会話を終了できます。',
          })
        ).catch((err) => log(`Chat help send failed: ${String(err)}`));
      });
    }

    return { status: 'replied', userText: question, isMaster };
  }
}
