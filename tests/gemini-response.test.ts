import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initConfig, resolveConfig } from '../src/config.js';
import { genTextByGemini } from '../src/modules/aichat/providers/gemini.js';
import type { ProviderContext } from '../src/modules/aichat/providers/types.js';
import type { AiChat } from '../src/modules/aichat/types.js';

let server: Server;
let baseUrl = '';
let nextResponse: unknown = {};

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
  server = createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(nextResponse));
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
});
