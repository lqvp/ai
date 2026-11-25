import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initConfig, resolveConfig } from '../src/config/index.js';
import {
  genTextByGemini,
  genTextByGeminiDetailed,
} from '../src/modules/aichat/providers/gemini.js';
import type { ProviderContext } from '../src/modules/aichat/providers/types.js';
import type { AiChat } from '../src/modules/aichat/types.js';

let server: Server;
let baseUrl = '';
let nextResponse: unknown = {};
let lastRequestBody: Record<string, unknown> | null = null;

const ctx: ProviderContext = {
  log: () => {},
  isMasterUser: () => false,
  isYoutubeUrl: () => false,
  collectUrlInfo: async () => ({
    youtubeURLs: [],
    hasYoutubeUrl: false,
    fallbackUrlInfo: '',
  }),
  formatTimelineContext: () => '',
};

function aiChat(): AiChat {
  return {
    question: 'こんにちは',
    prompt: 'テスト用プロンプト',
    api: baseUrl,
    key: 'test-key',
    fromMention: false,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      try {
        lastRequestBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        lastRequestBody = null;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(nextResponse));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  initConfig(resolveConfig({ host: baseUrl, i: 'token' }));
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('genTextByGemini のレスポンス処理', () => {
  it('candidates が欠落していてもエラーにせず空文字を返す', async () => {
    nextResponse = {};
    const result = await genTextByGemini(aiChat(), [], undefined, ctx);
    expect(result).toBe('');
  });

  it('candidates が空配列でもエラーにせず空文字を返す (回帰)', async () => {
    // 以前は candidates[0] をガード前に参照して TypeError となり、
    // 正常な空応答が { error: true } として扱われていた
    nextResponse = { candidates: [] };
    const result = await genTextByGemini(aiChat(), [], undefined, ctx);
    expect(result).toBe('');
  });

  it('正常応答から本文を取り出す', async () => {
    nextResponse = {
      candidates: [{ content: { parts: [{ text: 'やっほー' }] } }],
    };
    const result = await genTextByGemini(aiChat(), [], undefined, ctx);
    expect(result).toBe('やっほー');
  });

  it('thought パートを除外し、groundingMetadata を metadataSuffix に分離する', async () => {
    nextResponse = {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: '内部思考テキスト', thought: true },
              { text: 'こんにちは！' },
            ],
          },
          groundingMetadata: {
            groundingChunks: [
              { web: { uri: 'https://example.com', title: 'Example' } },
            ],
          },
        },
      ],
    };

    const detailed = await genTextByGeminiDetailed(
      aiChat(),
      [],
      undefined,
      ctx
    );
    expect(detailed).toEqual({
      text: 'こんにちは！',
      metadataSuffix: '参考(1): [Example](https://example.com)\n',
    });
  });

  it('url_context 使用時は systemInstruction にフォールバックURL情報を含めない', async () => {
    nextResponse = {
      candidates: [{ content: { parts: [{ text: '確認しました' }] } }],
    };
    await genTextByGeminiDetailed(
      {
        ...aiChat(),
        question: 'これ見て https://example.com/page',
        allowWebTools: true,
      },
      [],
      undefined,
      {
        ...ctx,
        collectUrlInfo: async () => ({
          youtubeURLs: [],
          hasYoutubeUrl: false,
          fallbackUrlInfo: 'FALLBACK_SHOULD_BE_REMOVED',
        }),
      }
    );

    const sysText = String(
      (
        lastRequestBody?.systemInstruction as
          | { parts?: { text?: string }[] }
          | undefined
      )?.parts?.[0]?.text ?? ''
    );
    expect(sysText).not.toContain('FALLBACK_SHOULD_BE_REMOVED');
  });
});
