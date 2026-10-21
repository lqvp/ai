import config from '@/config.js';
import { nowHour } from '@/services/clock.js';
import { getGeminiApiUrl } from './constants.js';
import type { AiChat, Base64File } from './types.js';

export type AutoNoteDeps = {
  log: (message: string) => void;
  getProvider: () => 'gemini' | 'openai';
  genText: (
    aiChat: AiChat,
    files: Base64File[]
  ) => Promise<
    | string
    | { error: true; errorCode?: number | null; errorMessage?: string | null }
    | null
  >;
  post: (options: { text: string }) => Promise<unknown>;
};

/**
 * 一定時間ごとに独り言を投稿する（Gemini の autoNote 機能）。
 * 有効化・確率・夜間停止の判定はすべて設定ファイル側で行う。
 */
export async function postAutoNote(deps: AutoNoteDeps): Promise<void> {
  const { log } = deps;

  if (!config.gemini?.enabled || !config.gemini?.autoNote?.enabled) {
    return;
  }

  if (config.gemini.autoNote.disableNightPosting) {
    const hour = nowHour();
    const nightStart = config.gemini.autoNote.nightHours?.start || 23;
    const nightEnd = config.gemini.autoNote.nightHours?.end || 5;

    if (hour >= nightStart || hour < nightEnd) {
      log(`深夜のため自動ノート投稿をスキップします（${hour}時）`);
      return;
    }
  }

  const probability = config.gemini.autoNote.probability;
  if (probability !== undefined && !Number.isNaN(probability)) {
    if (Math.random() >= probability) {
      log(
        `Gemini自動ノート投稿の確率によりスキップされました: probability=${probability}`
      );
      return;
    }
  }

  log('Gemini自動ノート投稿開始');

  const provider = deps.getProvider();
  const apiKey =
    provider === 'openai'
      ? config.aiProvider?.openai?.apiKey
      : config.gemini?.apiKey;
  const apiUrl =
    provider === 'openai'
      ? `${config.aiProvider?.openai?.baseUrl || 'https://api.openai.com'}/v1/chat/completions`
      : getGeminiApiUrl();

  if (!apiKey || !config.gemini.autoNote.prompt) {
    log('APIキーまたは自動ノート用プロンプトが設定されていません。');
    return;
  }

  const aiChat: AiChat = {
    question: '',
    prompt: config.gemini.autoNote.prompt,
    api: apiUrl,
    key: apiKey || '',
    fromMention: false,
  };

  try {
    const text = await deps.genText(aiChat, []);

    if (text != null && typeof text === 'object') {
      const codeText =
        typeof text.errorCode === 'number'
          ? `code=${text.errorCode}`
          : 'code=N/A';
      const messageText =
        typeof text.errorMessage === 'string'
          ? `message=${text.errorMessage}`
          : 'message=N/A';
      log(
        `Gemini自動ノートの生成でHTTPエラーが発生したため投稿をスキップします: ${codeText} ${messageText}`
      );
      return;
    }

    if (typeof text !== 'string') {
      log(
        `Gemini自動ノートの生成結果が文字列ではないため投稿をスキップします: type=${typeof text}`
      );
      return;
    }

    const normalizedText = text.trim();

    if (normalizedText === '') {
      log('Gemini自動ノートの生成結果が空文字のため投稿をスキップします。');
      return;
    }

    if (normalizedText.includes('[object Object]')) {
      log(
        'Gemini自動ノートの生成結果に不正な文字列([object Object])が含まれるため投稿をスキップします。'
      );
      return;
    }

    await deps.post({ text: normalizedText + ' #aichat' });
  } catch (error: unknown) {
    if (error instanceof Error) {
      log(
        `Gemini自動ノート処理中に例外が発生したため投稿をスキップします: ${error.message}`
      );
    } else {
      log(
        'Gemini自動ノート処理中に不明な例外が発生したため投稿をスキップします。'
      );
    }
  }
}
