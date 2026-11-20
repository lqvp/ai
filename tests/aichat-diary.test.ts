import loki from 'lokijs';
import { describe, expect, it } from 'vitest';
import type { Note } from '../src/misskey/types.js';
import type { DiaryEntry } from '../src/modules/aichat/diary-repository.js';
import { DiaryRepository } from '../src/modules/aichat/diary-repository.js';
import type { LlmCallFn } from '../src/modules/aichat/episode-extractor.js';
import { createDefaultMoodState } from '../src/modules/aichat/mood-state.js';
import {
  buildDiaryContext,
  buildTimelineInput,
  generateTlDiary,
} from '../src/modules/aichat/tl-diary.js';

const HOUR_MS = 60 * 60 * 1000;

function setupRepo() {
  const db = new loki('test-aichat-diary');
  const collection = db.addCollection<DiaryEntry>('aichatDiary', {
    indices: ['createdAt'],
  });
  return new DiaryRepository(collection);
}

function entry(partial: Partial<DiaryEntry> = {}): Omit<DiaryEntry, 'id'> {
  return {
    createdAt: Date.now(),
    content: '今日はタイムラインが平和だった。',
    moodAtWrite: 'calm',
    ...partial,
  };
}

function mockApi(response: string): LlmCallFn {
  return async () => response;
}

function throwingApi(): LlmCallFn {
  return async () => {
    throw new Error('API down');
  };
}

/** 必要なフィールドだけ持つ Note モック（misskey-js の Note はフィールドが多いため） */
function mockNote(
  partial: Partial<Note> & { userId: string; text?: string }
): Note {
  return {
    userId: partial.userId,
    text: partial.text ?? null,
    visibility: partial.visibility ?? 'public',
    user: { isBot: partial.user?.isBot ?? false } as Note['user'],
  } as unknown as Note;
}

describe('DiaryRepository', () => {
  it('inserts an entry with a generated id', () => {
    const repo = setupRepo();
    const inserted = repo.insert(entry());
    expect(typeof inserted.id).toBe('string');
    expect(inserted.id.length).toBeGreaterThan(0);
    expect(repo.count()).toBe(1);
  });

  it('findRecent returns entries newer than retention, newest first', () => {
    const repo = setupRepo();
    const now = Date.now();
    repo.insert(entry({ createdAt: now - 1 * HOUR_MS, content: '新しい日記' }));
    repo.insert(entry({ createdAt: now - 10 * HOUR_MS, content: '古い日記' }));
    const found = repo.findRecent({ retentionHours: 72, now });
    expect(found).toHaveLength(2);
    expect(found[0]?.content).toBe('新しい日記');
  });

  it('findRecent excludes entries older than retentionHours', () => {
    const repo = setupRepo();
    const now = Date.now();
    repo.insert(entry({ createdAt: now - 71 * HOUR_MS }));
    repo.insert(entry({ createdAt: now - 73 * HOUR_MS }));
    expect(repo.findRecent({ retentionHours: 72, now })).toHaveLength(1);
  });

  it('enforces maxEntries by dropping the oldest', () => {
    const repo = setupRepo();
    const now = Date.now();
    for (let i = 0; i < 25; i++) {
      repo.insert(
        entry({ createdAt: now - (25 - i) * HOUR_MS, content: `日記${i}` })
      );
    }
    // maxEntries=20（デフォルト）を超えた古い5件が削除される
    expect(repo.count()).toBe(20);
    expect(repo.findRecent({ now }).map((e) => e.content)).not.toContain(
      '日記0'
    );
  });

  it('pruneOldEntries removes entries past retention', () => {
    const repo = setupRepo();
    const now = Date.now();
    repo.insert(entry({ createdAt: now - 100 * HOUR_MS }));
    repo.insert(entry({ createdAt: now - 1 * HOUR_MS }));
    const removed = repo.pruneOldEntries(72, now);
    expect(removed).toBe(1);
    expect(repo.count()).toBe(1);
  });
});

describe('buildTimelineInput', () => {
  it('truncates each note to 200 chars and caps total at 15000', () => {
    const longText = 'あ'.repeat(500);
    const notes = Array.from({ length: 100 }, (_, i) =>
      mockNote({ userId: `user-${i}`, text: longText })
    );
    const input = buildTimelineInput(notes, 'bot-1');
    // 1ノート200字 + 改行1字で数え、連結後も15000字以内に収まる
    expect(input.length).toBeLessThanOrEqual(15000);
    // 最後の1ノートで上限を超えるため丸ごとスキップされ、
    // その手前まで（200字×74ノート + 改行×73）で打ち切られる
    expect(input.length).toBe(200 * 74 + 73);
  });

  it('excludes own notes and bot notes', () => {
    const input = buildTimelineInput(
      [
        mockNote({ userId: 'bot-1', text: '自分の投稿' }),
        mockNote({ userId: 'user-1', text: '人間の投稿' }),
        mockNote({
          userId: 'user-2',
          text: 'ボットの投稿',
          user: { isBot: true } as Note['user'],
        }),
      ],
      'bot-1'
    );
    expect(input).toBe('人間の投稿');
  });
});

describe('generateTlDiary', () => {
  function deps(repo: DiaryRepository) {
    return {
      api: async () => [mockNote({ userId: 'user-1', text: '今日はいい天気' })],
      selfUserId: 'bot-1',
      repository: repo,
    };
  }

  it('generates and stores a diary entry', async () => {
    const repo = setupRepo();
    const result = await generateTlDiary(
      deps(repo),
      mockApi('今日もタイムラインは穏やかだった。'),
      createDefaultMoodState(0)
    );
    expect(result).not.toBeNull();
    expect(repo.count()).toBe(1);
    expect(result?.moodAtWrite).toBe('calm');
  });

  it('returns null when the LLM returns empty text', async () => {
    const repo = setupRepo();
    const result = await generateTlDiary(deps(repo), mockApi('   '));
    expect(result).toBeNull();
    expect(repo.count()).toBe(0);
  });

  it('returns null when the LLM call throws', async () => {
    const repo = setupRepo();
    const result = await generateTlDiary(deps(repo), throwingApi());
    expect(result).toBeNull();
    expect(repo.count()).toBe(0);
  });

  it('returns null when timeline fetch fails', async () => {
    const repo = setupRepo();
    const failingDeps = {
      api: async () => {
        throw new Error('network error');
      },
      selfUserId: 'bot-1',
      repository: repo,
    };
    const result = await generateTlDiary(failingDeps, mockApi('日記'));
    expect(result).toBeNull();
    expect(repo.count()).toBe(0);
  });

  it('filters out own notes, bot notes and non-public visibility', async () => {
    const repo = setupRepo();
    const calls: string[] = [];
    const result = await generateTlDiary(
      {
        api: async () => [
          mockNote({ userId: 'bot-1', text: '自分' }),
          mockNote({
            userId: 'user-1',
            text: 'ボット',
            user: { isBot: true } as Note['user'],
          }),
          mockNote({
            userId: 'user-2',
            text: 'followersだけ',
            visibility: 'followers',
          }),
          mockNote({ userId: 'user-3', text: '公開投稿' }),
        ],
        selfUserId: 'bot-1',
        repository: repo,
      },
      async (_system, user) => {
        calls.push(user);
        return '日記';
      }
    );
    expect(result).not.toBeNull();
    expect(calls[0]).toContain('公開投稿');
    expect(calls[0]).not.toContain('followersだけ');
  });
});

describe('buildDiaryContext', () => {
  it('builds context capped at 2 most recent entries and 1000 chars', () => {
    const entries: DiaryEntry[] = [
      { ...entry({ content: '最新の日記' }), id: 'id-1' },
      { ...entry({ content: '2番目の古い日記' }), id: 'id-2' },
      { ...entry({ content: '3番目の古い日記' }), id: 'id-3' },
    ];
    const context = buildDiaryContext(entries);
    expect(context).toContain('最新の日記');
    expect(context).toContain('2番目の古い日記');
    expect(context).not.toContain('3番目の古い日記');
    expect(context.length).toBeLessThanOrEqual(1000);
  });

  it('returns empty string for no entries or all-over-limit lines', () => {
    expect(buildDiaryContext([])).toBe('');
    const long: DiaryEntry[] = [
      { ...entry({ content: 'あ'.repeat(2000) }), id: 'id-1' },
      { ...entry({ content: 'い'.repeat(2000) }), id: 'id-2' },
    ];
    // 全行が上限を超えるため、ヘッダだけの壊れたコンテキストにはならない
    expect(buildDiaryContext(long)).toBe('');
  });
});
