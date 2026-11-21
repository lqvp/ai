import loki from 'lokijs';
import { describe, expect, it } from 'vitest';
import type { EpisodeMemory } from '../src/modules/aichat/episode-memory.js';
import { EpisodeMemoryRepository } from '../src/modules/aichat/episode-memory-repository.js';
import { buildMemoryRecallContext } from '../src/modules/aichat/prompt-builder.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function setup() {
  const db = new loki('test-aichat-memory');
  const collection = db.addCollection<EpisodeMemory>('aichatMemory', {
    indices: ['userId', 'createdAt'],
  });
  return new EpisodeMemoryRepository(collection);
}

function memory(
  partial: Partial<EpisodeMemory> = {}
): Omit<EpisodeMemory, 'id'> {
  return {
    userId: 'user-1',
    kind: 'fact',
    content: 'ユーザーは猫を2匹飼っている',
    importance: 3,
    tags: ['pet'],
    createdAt: Date.now(),
    ...partial,
  };
}

describe('EpisodeMemoryRepository', () => {
  it('inserts a memory with a generated id', () => {
    const repo = setup();
    const inserted = repo.insert(memory());
    expect(typeof inserted.id).toBe('string');
    expect(inserted.id.length).toBeGreaterThan(0);
    expect(repo.findByUserId('user-1')).toHaveLength(1);
  });

  it('finds memories by userId and excludes other users', () => {
    const repo = setup();
    repo.insert(memory());
    repo.insert(memory({ userId: 'user-2' }));
    expect(repo.findByUserId('user-1')).toHaveLength(1);
  });

  it('filters by minImportance', () => {
    const repo = setup();
    repo.insert(memory({ importance: 2 }));
    repo.insert(memory({ importance: 5 }));
    const found = repo.findByUserId('user-1', { minImportance: 4 });
    expect(found).toHaveLength(1);
    expect(found[0]?.importance).toBe(5);
  });

  it('excludes superseded memories from results', () => {
    const repo = setup();
    const old = repo.insert(memory({ content: '旧住所は東京' }));
    const next = repo.insert(memory({ content: '新住所は大阪' }));
    repo.markSuperseded(old.id, next.id);
    const found = repo.findByUserId('user-1');
    expect(found).toHaveLength(1);
    expect(found[0]?.id).toBe(next.id);
  });

  it('archives old low-importance memories but keeps recent or important ones', () => {
    const repo = setup();
    const now = Date.now();
    repo.insert(memory({ createdAt: now - 100 * DAY_MS, importance: 1 }));
    repo.insert(memory({ createdAt: now - 100 * DAY_MS, importance: 3 }));
    repo.insert(memory({ createdAt: now - 10 * DAY_MS, importance: 1 }));

    const archived = repo.pruneOldMemories(now);
    expect(archived).toBe(1);
    // 90日超えかつ重要度2以下の1件だけがアーカイブされる
    expect(repo.findByUserId('user-1')).toHaveLength(2);
  });

  it('does not archive already archived memories twice', () => {
    const repo = setup();
    const now = Date.now();
    repo.insert(memory({ createdAt: now - 100 * DAY_MS, importance: 2 }));
    repo.pruneOldMemories(now);
    expect(repo.pruneOldMemories(now)).toBe(0);
  });

  it('counts memories per user including archived', () => {
    const repo = setup();
    const now = Date.now();
    repo.insert(memory({ createdAt: now - 100 * DAY_MS, importance: 1 }));
    repo.pruneOldMemories(now);
    repo.insert(memory());
    expect(repo.countByUserId('user-1')).toBe(2);
  });
});

describe('buildMemoryRecallContext', () => {
  it('returns empty string when no memory has importance >= 4', () => {
    const repo = setup();
    repo.insert(memory({ importance: 3 }));
    expect(buildMemoryRecallContext(repo.findByUserId('user-1'))).toBe('');
  });

  it('formats high-importance memories as recall context', () => {
    const repo = setup();
    repo.insert(memory({ importance: 5, content: 'ユーザーの誕生日は4月1日' }));
    const text = buildMemoryRecallContext(repo.findByUserId('user-1'));
    expect(text).toContain('ユーザーの誕生日は4月1日');
  });

  it('caps total length at 2000 chars', () => {
    const repo = setup();
    repo.insert(memory({ importance: 5, content: 'あ'.repeat(50) }));
    repo.insert(memory({ importance: 5, content: 'い'.repeat(3000) }));
    const text = buildMemoryRecallContext(repo.findByUserId('user-1'));
    // 短い記憶は載り、長すぎる記憶は打ち切られる（順序に依存しない）
    expect(text).toContain('あ'.repeat(50));
    expect(text.length).toBeLessThanOrEqual(2000);
  });
});
