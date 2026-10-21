import config from '@/config.js';

/** API関連定数 */
export const TYPE_GEMINI = 'gemini';
export const GROUNDING_TARGET = 'ggg';

export function getGeminiApiUrl(): string {
  const model = config.gemini?.model || 'gemini-2.5-flash';
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

export const EXA_TOOL_SEARCH = 'exa_search';
export const JINA_TOOL_READ = 'jina_read';

/** タイミング関連定数 */
export const TIMEOUT_TIME = 1000 * 60 * 30; // 30分（0.5時間）
export const MINUTES_TO_MS = 60 * 1000;
export const HOURS_TO_MS = 60 * MINUTES_TO_MS;

/** デフォルト設定値 */
export const DEFAULTS = {
  RANDOMTALK_PROBABILITY: 0.02,
  RANDOMTALK_INTERVAL_HOURS: 12,
  AUTO_NOTE_INTERVAL_HOURS: 6,
  AUTO_NOTE_PROBABILITY: 0.02,
  MAX_HISTORY_LENGTH: 10,
} as const;
