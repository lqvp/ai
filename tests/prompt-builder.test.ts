import { describe, expect, it } from 'vitest';
import {
  buildBaseInstruction,
  buildGeminiContents,
  buildOpenaiMessages,
  formatNow,
} from '../src/modules/aichat/prompt-builder.js';
import type { AiChat } from '../src/modules/aichat/types.js';

const baseChat = (overrides: Partial<AiChat> = {}): AiChat => ({
  question: 'こんにちは',
  prompt: 'あなたは藍です。',
  api: 'https://example.com',
  key: 'key',
  fromMention: true,
  ...overrides,
});

describe('buildBaseInstruction', () => {
  it('includes the prompt, constraints, current time and master flag', () => {
    const text = buildBaseInstruction(baseChat(), {
      isMaster: true,
      now: '2026/10/22 12:00',
    });

    expect(text).toContain('あなたは藍です。');
    expect(text).toContain('Markdownを使って返答してください。');
    expect(text).toContain('2026/10/22 12:00');
    expect(text).toContain('(true)');
  });

  it('marks non-master users and mentions the friend name', () => {
    const text = buildBaseInstruction(baseChat({ friendName: 'テスト' }), {
      isMaster: false,
      now: '2026/10/22 12:00',
    });

    expect(text).toContain('会話相手の名前はテスト');
    expect(text).toContain('(false)');
  });

  it('adds the random-talk notice only when not from a mention', () => {
    const mentioned = buildBaseInstruction(baseChat(), { isMaster: false });
    const randomTalk = buildBaseInstruction(baseChat({ fromMention: false }), {
      isMaster: false,
    });

    expect(mentioned).not.toContain('あなたに対するメッセージではない');
    expect(randomTalk).toContain('あなたに対するメッセージではない');
  });

  it('adds the grounding rule only for the Gemini path', () => {
    const chat = baseChat({ grounding: true });
    expect(
      buildBaseInstruction(chat, {
        isMaster: false,
        includeGroundingRule: true,
      })
    ).toContain('Google search with grounding.');
    expect(buildBaseInstruction(chat, { isMaster: false })).not.toContain(
      'Google search with grounding.'
    );
  });

  it('formats the current time in Asia/Tokyo', () => {
    expect(formatNow(new Date('2026-01-01T00:00:00Z'))).toContain('2026/01/01');
  });
});

describe('buildGeminiContents', () => {
  it('puts history first, then the current question with attachments', () => {
    const contents = buildGeminiContents(
      baseChat({
        history: [
          { role: 'user', content: '前の質問' },
          { role: 'model', content: '前の回答' },
        ],
      }),
      [{ type: 'image/png', base64: 'AAAA' }],
      ['https://www.youtube.com/watch?v=abc']
    );

    expect(contents).toHaveLength(3);
    expect(contents[0]).toEqual({
      role: 'user',
      parts: [{ text: '前の質問' }],
    });
    expect(contents[2].parts[0]).toEqual({ text: 'こんにちは' });
    expect(contents[2].parts[1]).toEqual({
      fileData: {
        mimeType: 'video/mp4',
        fileUri: 'https://www.youtube.com/watch?v=abc',
      },
    });
    expect(contents[2].parts[2]).toEqual({
      inlineData: { mimeType: 'image/png', data: 'AAAA' },
    });
  });
});

describe('buildOpenaiMessages', () => {
  it('maps model history to assistant and keeps tool-free text messages', () => {
    const messages = buildOpenaiMessages(
      baseChat({
        history: [
          { role: 'user', content: '質問' },
          { role: 'model', content: '回答' },
        ],
      }),
      [],
      'system prompt'
    );

    expect(messages[0]).toEqual({ role: 'system', content: 'system prompt' });
    expect(messages[1]).toEqual({ role: 'user', content: '質問' });
    expect(messages[2]).toEqual({ role: 'assistant', content: '回答' });
    expect(messages[3]).toEqual({ role: 'user', content: 'こんにちは' });
  });

  it('builds multimodal content when files exist', () => {
    const messages = buildOpenaiMessages(
      baseChat(),
      [{ type: 'image/jpeg', base64: 'BBBB' }],
      'sys'
    );

    const last = messages[messages.length - 1];
    expect(Array.isArray(last.content)).toBe(true);
    expect(last.content).toEqual([
      { type: 'text', text: 'こんにちは' },
      {
        type: 'image_url',
        image_url: { url: 'data:image/jpeg;base64,BBBB' },
      },
    ]);
  });
});
