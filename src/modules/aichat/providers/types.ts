import type Message from '@/message.js';
import type { AiChat } from '../types.js';

/**
 * プロバイダ実装（Gemini / OpenAI 互換）が必要とするモジュール側の機能。
 * ここを満たせば別プロバイダを追加できる。
 */
export type ProviderContext = {
  log: (message: string) => void;
  isMasterUser: (msg: Message) => boolean;
  isYoutubeUrl: (url: string) => boolean;
  collectUrlInfo: (aiChat: AiChat) => Promise<{
    youtubeURLs: string[];
    hasYoutubeUrl: boolean;
    fallbackUrlInfo: string;
  }>;
  formatTimelineContext: (
    context?: { before?: any[]; after?: any[] } | null
  ) => string;
};
