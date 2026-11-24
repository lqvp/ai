import type Message from '@/message.js';
import {
  genTextByGeminiDetailed,
  type ProviderContext,
} from './providers/gemini.js';
import { genTextByOpenaiDetailed } from './providers/openai.js';
import type {
  AiChat,
  Base64File,
  GeminiApiResponse,
  ProviderDetailedResponse,
} from './types.js';

/**
 * テキスト生成器が必要とするモジュール側の機能。
 * 中身はプロバイダ実装と共通の `ProviderContext`。
 */
export type TextGeneratorContext = ProviderContext;

/**
 * Gemini / OpenAI 互換 API の呼び出しをプロバイダごとの実装に振り分ける。
 */
export class TextGenerator {
  constructor(private readonly ctx: ProviderContext) {}

  public async genTextDetailed(
    provider: 'gemini' | 'openai',
    aiChat: AiChat,
    files: Base64File[],
    msg?: Message
  ): Promise<ProviderDetailedResponse> {
    this.ctx.log(`Using AI provider: ${provider}`);

    if (provider === 'openai') {
      return genTextByOpenaiDetailed(aiChat, files, msg, this.ctx);
    }
    return genTextByGeminiDetailed(aiChat, files, msg, this.ctx);
  }

  public async genText(
    provider: 'gemini' | 'openai',
    aiChat: AiChat,
    files: Base64File[],
    msg?: Message
  ): Promise<GeminiApiResponse> {
    const res = await this.genTextDetailed(provider, aiChat, files, msg);
    if (res == null || 'error' in res) return res;
    return `${res.text}${res.metadataSuffix}`;
  }
}
