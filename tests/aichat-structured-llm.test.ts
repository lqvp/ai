import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initConfig, resolveConfig } from '../src/config/index.js';
import {
  callStructuredJson,
  extractJsonObject,
  stripThinkingTags,
} from '../src/modules/aichat/structured-llm.js';

let server: Server;
let baseUrl = '';
let nextResponse: unknown = {};
let lastRequest: {
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: Record<string, unknown> | null;
} | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      let body: Record<string, unknown> | null = null;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        body = null;
      }
      lastRequest = {
        url: req.url ?? '',
        headers: req.headers,
        body,
      };
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

describe('stripThinkingTags & extractJsonObject', () => {
  it('strips matched <think>, orphan closing </think>, and unclosed <think>', () => {
    expect(stripThinkingTags('<think>secret</think>{"ok":true}')).toBe(
      '{"ok":true}'
    );
    expect(stripThinkingTags('preface thoughts\n</think>\n{"ok":true}')).toBe(
      '{"ok":true}'
    );
    expect(
      stripThinkingTags('<think>truncated before finish {"ok":true}')
    ).toBe('');
  });

  it('extracts JSON from markdown fences, prose + braces, and repairs trailing commas', () => {
    const fenced = '```json\n{"text": "code: ```ts```", "n": 1,}\n```';
    expect(extractJsonObject(fenced)).toEqual({
      text: 'code: ```ts```',
      n: 1,
    });

    const noisy =
      '結果はこちらです。\n{"delta": 2, "note": "line1\nline2",}\n以上！';
    expect(extractJsonObject(noisy)).toEqual({
      delta: 2,
      note: 'line1\nline2',
    });

    expect(extractJsonObject('<think>{"a":1}')).toBeNull();
  });
});

describe('callStructuredJson', () => {
  it('calls Gemini with responseMimeType, skips thought parts, and omits thinkingConfig/tools', async () => {
    nextResponse = {
      candidates: [
        {
          finishReason: 'STOP',
          content: {
            parts: [
              { text: '{"delta": 99}', thought: true },
              { text: '{"delta": 1}' },
            ],
          },
        },
      ],
    };

    const res = await callStructuredJson<{ delta: number }>({
      provider: 'gemini',
      geminiConfig: { apiKey: 'g-key', apiUrl: `${baseUrl}/gemini` },
      system: 'sys',
      user: 'usr',
      maxTokens: 256,
      parse: (obj) =>
        typeof obj.delta === 'number' ? { delta: obj.delta } : null,
    });

    expect(res).toEqual({ delta: 1 });
    expect(lastRequest?.body?.tools).toBeUndefined();
    const genCfg = lastRequest?.body?.generationConfig as Record<
      string,
      unknown
    >;
    expect(genCfg.responseMimeType).toBe('application/json');
    expect(genCfg.thinkingConfig).toBeUndefined();
  });

  it('calls OpenAI key-less without Authorization or response_format by default', async () => {
    nextResponse = {
      choices: [{ message: { content: 'thinking...</think>{"ok": true}' } }],
    };

    const res = await callStructuredJson<{ ok: boolean }>({
      provider: 'openai',
      openaiConfig: { baseUrl, model: 'local-glm' },
      system: 'sys',
      user: 'usr',
      maxTokens: 256,
      parse: (obj) => (typeof obj.ok === 'boolean' ? { ok: obj.ok } : null),
    });

    expect(res).toEqual({ ok: true });
    expect(lastRequest?.headers.authorization).toBeUndefined();
    expect(lastRequest?.body?.response_format).toBeUndefined();

    await callStructuredJson({
      provider: 'openai',
      openaiConfig: { baseUrl, model: 'local-glm', jsonMode: 'json_object' },
      system: 'sys',
      user: 'usr',
      maxTokens: 256,
      parse: (obj) => obj,
    });
    expect(lastRequest?.body?.response_format).toEqual({ type: 'json_object' });
  });
});
