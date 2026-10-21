import type Message from '@/message.js';
import { genTextByGemini, type ProviderContext } from './providers/gemini.js';
import { genTextByOpenai } from './providers/openai.js';
import type { AiChat, Base64File, GeminiApiResponse } from './types.js';

/**
 * テキスト生成器が必要とするモジュール側の機能。
 * 中身はプロバイダ実装と共通の `ProviderContext`。
 */
export type TextGeneratorContext = ProviderContext;

/**
 * Gemini / OpenAI 互換 API の呼び出しをプロバイダごとの実装に振り分ける。
 *
 * 以前は 2,000 行超の `aichat/index.ts` にべったり書かれていた。
 * 実装は `providers/gemini.ts` と `providers/openai.ts`、ツール実行は `tools.ts`。
 */
export class TextGenerator {
  constructor(private readonly ctx: ProviderContext) {}

  public async genText(
    provider: 'gemini' | 'openai',
    aiChat: AiChat,
    files: Base64File[],
    msg?: Message
  ): Promise<GeminiApiResponse> {
    this.ctx.log(`Using AI provider: ${provider}`);

    if (provider === 'openai') {
      return genTextByOpenai(aiChat, files, msg, this.ctx);
    }
    return genTextByGemini(aiChat, files, msg, this.ctx);
  }
}
