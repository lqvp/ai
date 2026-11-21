import config from '@/config/index.js';

/**
 * OpenAI 互換 API の接続・生成パラメータ。
 * `apiKey` はキー不要なエンドポイント（vLLM など）を考慮して任意。
 */
export type OpenaiSettings = {
  model: string;
  apiUrl: string;
  apiKey?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs: number;
};

/** config の [aiProvider.openai] 相当の形（テストから直接渡せるように分離）。 */
export type OpenaiProviderConfig = {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
};

const DEFAULT_BASE_URL = 'https://api.openai.com';
const DEFAULT_MODEL = 'gpt-4o-mini';
const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * baseUrl を chat/completions のフルURLへ正規化する。
 * `https://host` と `https://host/v1` の両方の表記を許容する。
 */
export function buildChatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '');
  const base = trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`;
  return `${base}/chat/completions`;
}

/**
 * 設定ファイルから OpenAI 互換 API の設定を解決する。
 * 引数を渡さなければ実行中の設定を使用する（テストでは raw を直接渡す）。
 */
export function resolveOpenaiSettings(
  raw?: OpenaiProviderConfig
): OpenaiSettings {
  const conf = raw ?? config.aiProvider?.openai;
  const baseUrl = conf?.baseUrl || DEFAULT_BASE_URL;
  return {
    model: conf?.model || DEFAULT_MODEL,
    apiUrl: buildChatCompletionsUrl(baseUrl),
    apiKey: conf?.apiKey,
    temperature: conf?.temperature,
    maxTokens: conf?.maxTokens,
    timeoutMs: conf?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  };
}
