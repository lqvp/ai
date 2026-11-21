import loki from 'lokijs';
import { describe, expect, it } from 'vitest';
import type { LlmCallFn } from '../src/modules/aichat/episode-extractor.js';
import type { EpisodeMemory } from '../src/modules/aichat/episode-memory.js';
import { FollowupStateRepository } from '../src/modules/aichat/followup-state.js';
import {
  decideFollowUps,
  type FollowUpCandidate,
  runProactiveFollowUp,
} from '../src/modules/aichat/proactive-followup.js';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

function setupState(): FollowupStateRepository {
  const db = new loki('test-aichat-followup');
  const collection = db.addCollection<FollowupStateRecord>(
    'aichatFollowupState',
    { indices: ['userId'] }
  );
  return new FollowupStateRepository(collection);
}

type FollowupStateRecord = {
  userId: string;
  lastFollowUpAt: number | null;
  ignoredCount: number;
  cooldownUntil: number | null;
  settledFollowUpAt: number | null;
};

function memory(partial: Partial<EpisodeMemory> = {}): EpisodeMemory {
  return {
    id: 'mem-1',
    userId: 'user-1',
    kind: 'episode',
    content: '就職活動中で面接が続いている',
    importance: 4,
    tags: ['work'],
    createdAt: Date.now() - DAY_MS,
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

const candidate: FollowUpCandidate = {
  userId: 'user-1',
  message: 'そういえば、面接の結果はどうでしたか？',
  reason: '就活の継続的な用件を気にかけるべき',
};

describe('decideFollowUps', () => {
  it('returns candidates from valid JSON', async () => {
    const api = mockApi(JSON.stringify({ followUps: [candidate] }));
    const result = await decideFollowUps([memory()], api);
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe('user-1');
  });

  it('returns empty on invalid JSON', async () => {
    const api = mockApi('これはJSONではありません');
    const result = await decideFollowUps([memory()], api);
    expect(result).toEqual([]);
  });

  it('returns empty when response has no JSON object', async () => {
    const result = await decideFollowUps([memory()], mockApi('no json'));
    expect(result).toEqual([]);
  });

  it('returns empty when followUps is empty', async () => {
    const api = mockApi(JSON.stringify({ followUps: [] }));
    const result = await decideFollowUps([memory()], api);
    expect(result).toEqual([]);
  });

  it('filters memories below importance 3 without calling the LLM', async () => {
    let called = false;
    const api: LlmCallFn = async () => {
      called = true;
      return JSON.stringify({ followUps: [candidate] });
    };
    const result = await decideFollowUps([memory({ importance: 2 })], api);
    expect(result).toEqual([]);
    expect(called).toBe(false);
  });

  it('drops invalid candidate entries', async () => {
    const api = mockApi(
      JSON.stringify({
        followUps: [
          { userId: '', message: 'x', reason: 'r' },
          { userId: 'user-2', message: 123, reason: 'r' },
          candidate,
        ],
      })
    );
    const result = await decideFollowUps([memory()], api);
    expect(result).toHaveLength(1);
    expect(result[0]?.userId).toBe('user-1');
  });

  it('returns empty when the LLM call throws', async () => {
    const result = await decideFollowUps([memory()], throwingApi());
    expect(result).toEqual([]);
  });
});

describe('FollowupStateRepository', () => {
  it('allows sending to untracked users', () => {
    const state = setupState();
    expect(state.canSend('user-1', 72 * HOUR_MS, Date.now())).toBe(true);
  });

  it('throttles re-sending within the window (72h)', () => {
    const state = setupState();
    const now = Date.now();
    state.recordFollowUp('user-1', now);
    expect(state.canSend('user-1', 72 * HOUR_MS, now + 24 * HOUR_MS)).toBe(
      false
    );
    expect(state.canSend('user-1', 72 * HOUR_MS, now + 72 * HOUR_MS)).toBe(
      true
    );
  });

  it('applies 7-day cooldown after 2 consecutive ignores', () => {
    const state = setupState();
    const now = Date.now();
    state.recordFollowUp('user-1', now);
    // 1回目の無視（24時間経過・反応なし）でもクールダウンは入らない
    state.settleIgnored(
      'user-1',
      false,
      now + 25 * HOUR_MS,
      24 * HOUR_MS,
      7 * DAY_MS
    );
    expect(state.canSend('user-1', 72 * HOUR_MS, now + 73 * HOUR_MS)).toBe(
      true
    );
    // 再送後に2回目の無視でクールダウンへ
    state.recordFollowUp('user-1', now + 72 * HOUR_MS);
    state.settleIgnored(
      'user-1',
      false,
      now + 97 * HOUR_MS,
      24 * HOUR_MS,
      7 * DAY_MS
    );
    expect(state.canSend('user-1', 72 * HOUR_MS, now + 100 * HOUR_MS)).toBe(
      false
    );
    // クールダウン期間（7日）が過ぎれば再び送れる
    expect(
      state.canSend('user-1', 72 * HOUR_MS, now + 8 * DAY_MS + 100 * HOUR_MS)
    ).toBe(true);
  });

  it('does not double-count the same ignored follow-up', () => {
    const state = setupState();
    const now = Date.now();
    state.recordFollowUp('user-1', now);
    state.settleIgnored(
      'user-1',
      false,
      now + 25 * HOUR_MS,
      24 * HOUR_MS,
      7 * DAY_MS
    );
    state.settleIgnored(
      'user-1',
      false,
      now + 30 * HOUR_MS,
      24 * HOUR_MS,
      7 * DAY_MS
    );
    // 同じフォローアップの無視は1回だけカウントされる
    const tracked = state.findAll()[0];
    expect(tracked.ignoredCount).toBe(1);
  });

  it('resets ignore count when the user interacts', () => {
    const state = setupState();
    const now = Date.now();
    state.recordFollowUp('user-1', now);
    state.settleIgnored(
      'user-1',
      false,
      now + 25 * HOUR_MS,
      24 * HOUR_MS,
      7 * DAY_MS
    );
    state.markReplied('user-1');
    const tracked = state.findAll()[0];
    expect(tracked.ignoredCount).toBe(0);
  });
});

describe('runProactiveFollowUp', () => {
  function setupDeps(
    overrides: Partial<Parameters<typeof runProactiveFollowUp>[0]> = {}
  ) {
    const state = setupState();
    const sent: { userId: string; message: string }[] = [];
    const deps = {
      memories: [memory()],
      api: mockApi(JSON.stringify({ followUps: [candidate] })),
      state,
      isFriend: () => true,
      isMasterUser: async () => false,
      send: async (userId: string, message: string) => {
        sent.push({ userId, message });
      },
      hasInteractedSince: async () => false,
      now: () => 1000000,
      ...overrides,
    };
    return { deps, sent, state };
  }

  it('sends at most one follow-up per run even with multiple candidates', async () => {
    const { deps, sent } = setupDeps({
      api: mockApi(
        JSON.stringify({
          followUps: [candidate, { ...candidate, userId: 'user-2' }],
        })
      ),
    });
    const result = await runProactiveFollowUp(deps);
    expect(result?.userId).toBe('user-1');
    expect(sent).toHaveLength(1);
  });

  it('does not send to non-friend users', async () => {
    const { deps, sent } = setupDeps({ isFriend: () => false });
    const result = await runProactiveFollowUp(deps);
    expect(result).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('respects the per-user throttle', async () => {
    const { deps, sent, state } = setupDeps();
    await runProactiveFollowUp(deps);
    expect(sent).toHaveLength(1);
    // 直後の実行ではスロットルにより送らない
    const second = await runProactiveFollowUp(deps);
    expect(second).toBeNull();
    expect(sent).toHaveLength(1);
    expect(state.findAll()).toHaveLength(1);
  });

  it('exempts the master user from the throttle', async () => {
    const { deps, sent, state } = setupDeps({
      isMasterUser: async (userId) => userId === 'user-1',
    });
    await runProactiveFollowUp(deps);
    const second = await runProactiveFollowUp(deps);
    expect(second?.userId).toBe('user-1');
    expect(sent).toHaveLength(2);
    expect(state.findAll()).toHaveLength(1);
  });

  it('does not send when the LLM returns no follow-ups', async () => {
    const { deps, sent } = setupDeps({
      api: mockApi(JSON.stringify({ followUps: [] })),
    });
    const result = await runProactiveFollowUp(deps);
    expect(result).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it('never throws when sending fails', async () => {
    const { deps } = setupDeps({
      send: async () => {
        throw new Error('send failed');
      },
    });
    const result = await runProactiveFollowUp(deps);
    expect(result).toBeNull();
  });

  it('never throws when settle and LLM both fail', async () => {
    const { deps } = setupDeps({
      hasInteractedSince: async () => {
        throw new Error('history broken');
      },
      api: throwingApi(),
    });
    const result = await runProactiveFollowUp(deps);
    expect(result).toBeNull();
  });
});
