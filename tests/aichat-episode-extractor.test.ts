import { describe, expect, it } from 'vitest';
import type { LlmCallFn } from '../src/modules/aichat/episode-extractor.js';
import {
  extractEpisodes,
  resolveContradictions,
} from '../src/modules/aichat/episode-extractor.js';
import type { EpisodeMemory } from '../src/modules/aichat/episode-memory.js';

/** 十分な長さの会話（2ターン以上・合計100文字以上） */
const longHistory = [
  {
    role: 'user',
    content:
      'そういえば、先月から猫を2匹飼い始めたんだ。名前はミケとタマだよ。里親施設で保護されていた子たちなんだ。',
  },
  { role: 'assistant', content: '素敵ですね！猫さんの様子はどうですか？' },
  {
    role: 'user',
    content:
      'ミケは元気に走り回っていて、タマはよく寝ています。世話が大変だけど、毎日が楽しくて仕方がないです。',
  },
];

/** LLMの代わりに固定文字列を返すモック */
function mockApi(response: string): LlmCallFn {
  return async () => response;
}

function existingMemory(id: string, content: string): EpisodeMemory {
  return {
    id,
    userId: 'user-1',
    kind: 'fact',
    content,
    importance: 3,
    tags: [],
    createdAt: Date.now(),
  };
}

describe('extractEpisodes', () => {
  it('extracts memories from valid JSON response', async () => {
    const api = mockApi(
      JSON.stringify([
        {
          kind: 'fact',
          content: 'ユーザーはミケとタマという2匹の猫を飼っている',
          importance: 4,
          tags: ['pet'],
        },
      ])
    );
    const memories = await extractEpisodes(longHistory, 'user-1', api);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.userId).toBe('user-1');
    expect(memories[0]?.content).toBe(
      'ユーザーはミケとタマという2匹の猫を飼っている'
    );
    expect(memories[0]?.importance).toBe(4);
  });

  it('parses JSON embedded in surrounding text', async () => {
    const api = mockApi(
      '抽出結果は以下の通りです。\n[{"kind":"preference","content":"猫好き","importance":3,"tags":["like"]}]'
    );
    const memories = await extractEpisodes(longHistory, 'user-1', api);
    expect(memories).toHaveLength(1);
    expect(memories[0]?.kind).toBe('preference');
  });

  it('returns empty array for invalid JSON', async () => {
    const api = mockApi('これはJSONではありません');
    const memories = await extractEpisodes(longHistory, 'user-1', api);
    expect(memories).toEqual([]);
  });

  it('returns empty array for empty history', async () => {
    const api = mockApi(
      '[{"kind":"fact","content":"x","importance":3,"tags":[]}]'
    );
    const memories = await extractEpisodes([], 'user-1', api);
    expect(memories).toEqual([]);
  });

  it('returns empty array when history is too short', async () => {
    const api = mockApi('[]');
    const memories = await extractEpisodes(
      [{ role: 'user', content: 'こんにちは' }],
      'user-1',
      api
    );
    expect(memories).toEqual([]);
  });

  it('returns empty array when total content is under 100 chars', async () => {
    const api = mockApi('[]');
    const memories = await extractEpisodes(
      [
        { role: 'user', content: 'こんにちは' },
        { role: 'assistant', content: 'こんにちは！' },
      ],
      'user-1',
      api
    );
    expect(memories).toEqual([]);
  });

  it('returns empty array when LLM call throws', async () => {
    const api: LlmCallFn = async () => {
      throw new Error('LLM down');
    };
    const memories = await extractEpisodes(longHistory, 'user-1', api);
    expect(memories).toEqual([]);
  });
});

describe('resolveContradictions', () => {
  const newMemories = [
    {
      userId: 'user-1',
      kind: 'fact' as const,
      content: 'ユーザーの住所は大阪',
      importance: 3,
      tags: [],
      createdAt: Date.now(),
    },
  ];

  it('maps new memories to superseded existing ids', async () => {
    const api = mockApi(
      JSON.stringify([{ newIndex: 0, supersedeIds: ['old-1'] }])
    );
    const map = await resolveContradictions(
      newMemories,
      [existingMemory('old-1', 'ユーザーの住所は東京')],
      api
    );
    expect(map.get(0)).toEqual(['old-1']);
  });

  it('returns empty map when LLM returns empty array', async () => {
    const api = mockApi('[]');
    const map = await resolveContradictions(
      newMemories,
      [existingMemory('old-1', 'ユーザーの住所は東京')],
      api
    );
    expect(map.size).toBe(0);
  });

  it('ignores ids that do not exist in existing memories', async () => {
    const api = mockApi(
      JSON.stringify([{ newIndex: 0, supersedeIds: ['unknown-id'] }])
    );
    const map = await resolveContradictions(
      newMemories,
      [existingMemory('old-1', 'ユーザーの住所は東京')],
      api
    );
    expect(map.size).toBe(0);
  });

  it('returns empty map when LLM call throws (skip contradiction handling)', async () => {
    const api: LlmCallFn = async () => {
      throw new Error('LLM down');
    };
    const map = await resolveContradictions(
      newMemories,
      [existingMemory('old-1', 'ユーザーの住所は東京')],
      api
    );
    // 失敗時は矛盾処理をスキップし、すべて挿入される前提で空マップを返す
    expect(map.size).toBe(0);
  });
});
