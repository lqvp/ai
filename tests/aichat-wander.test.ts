import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import loki from 'lokijs';
import { afterEach, describe, expect, it } from 'vitest';
import type { PostParam } from '../src/api/APIClient.js';
import type { Note, User } from '../src/misskey/types.js';
import { AffinityStore } from '../src/modules/aichat/affinity-store.js';
import { EmojiCatalog } from '../src/modules/aichat/emoji-catalog.js';
import {
  type AiChatHist,
  ChatHistoryRepository,
} from '../src/modules/aichat/history-repository.js';
import { PlaybookLoader } from '../src/modules/aichat/playbook.js';
import { WanderRunner } from '../src/modules/aichat/wander.js';
import {
  decideWanderTick,
  drawHourlySlots,
} from '../src/modules/aichat/wander-scheduler.js';
import { WanderStore } from '../src/modules/aichat/wander-store.js';

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-aichat-wander-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeNote(overrides: Partial<Note> & { id: string }): Note {
  const user: User = {
    id: overrides.userId ?? 'u-1',
    username: 'alice',
    host: null,
    isBot: false,
    name: 'Alice',
    ...(overrides.user as Partial<User> | undefined),
  } as User;

  return {
    createdAt: new Date(
      Date.parse('2026-11-24T12:00:00+09:00') - 5 * 60_000
    ).toISOString(),
    text: '今日はいい天気ですね！お茶を飲んでいます',
    cw: null,
    userId: user.id,
    user,
    replyId: null,
    renoteId: null,
    visibility: 'public',
    files: [],
    myReaction: null,
    ...overrides,
  } as Note;
}

describe('decideWanderTick (ADR 0002 scheduler)', () => {
  it('blocks ticks outside active hours and enforces minGapMinutes between slots', () => {
    const night = Date.parse('2026-11-24T02:00:00+09:00');
    const nightRes = decideWanderTick(
      night,
      {},
      { activeHoursStart: 9, activeHoursEnd: 23 }
    );
    expect(nightRes.run).toBe(false);
    expect(nightRes.reason).toBe('outside_active_hours');

    const noon = Date.parse('2026-11-24T12:00:00+09:00');
    const drawn = decideWanderTick(
      noon,
      { lastRunAt: noon - 5 * 60_000 },
      { activeHoursStart: 9, activeHoursEnd: 23, minGapMinutes: 10 },
      () => 0.5
    );
    expect(drawn.state.hour).toBe('2026-11-24T12');
    for (let i = 1; i < (drawn.state.slots ?? []).length; i++) {
      expect(
        drawn.state.slots![i] - drawn.state.slots![i - 1]
      ).toBeGreaterThanOrEqual(10);
    }
    expect(drawn.state.slots).not.toContain(0);
  });

  it('draws fixed slot counts and zero slots when minRunsPerHour/maxRunsPerHour match', () => {
    const noon = Date.parse('2026-11-24T12:00:00+09:00');

    const fixed = decideWanderTick(
      noon,
      {},
      {
        activeHoursStart: 9,
        activeHoursEnd: 23,
        minGapMinutes: 10,
        minRunsPerHour: 4,
        maxRunsPerHour: 4,
      },
      () => 0.5
    );
    expect(fixed.state.slots).toHaveLength(4);
    for (let i = 1; i < (fixed.state.slots ?? []).length; i++) {
      expect(
        fixed.state.slots![i] - fixed.state.slots![i - 1]
      ).toBeGreaterThanOrEqual(10);
    }

    const zero = decideWanderTick(
      noon,
      {},
      {
        activeHoursStart: 9,
        activeHoursEnd: 23,
        minGapMinutes: 10,
        minRunsPerHour: 0,
        maxRunsPerHour: 0,
      },
      () => 0.5
    );
    expect(zero.run).toBe(false);
    expect(zero.reason).toBe('not_slot');
    expect(zero.state.slots).toEqual([]);
  });

  it('draws counts uniformly within custom [minRunsPerHour, maxRunsPerHour] and supports single-sided bounds', () => {
    const noon = Date.parse('2026-11-24T12:00:00+09:00');

    for (const [r, expected] of [
      [0, 2],
      [0.5, 4],
      [0.999, 5],
    ] as const) {
      const slots = drawHourlySlots(noon, 0, 0, undefined, 5, () => r, {
        minRunsPerHour: 2,
        maxRunsPerHour: 5,
      });
      expect(slots).toHaveLength(expected);
    }

    expect(
      drawHourlySlots(noon, 0, 0, undefined, 5, () => 0, {
        minRunsPerHour: 2,
      })
    ).toHaveLength(2);
    expect(
      drawHourlySlots(noon, 0, 0, undefined, 5, () => 0.999, {
        minRunsPerHour: 2,
      })
    ).toHaveLength(3);
    expect(
      drawHourlySlots(noon, 0, 0, undefined, 5, () => 0.5, {
        minRunsPerHour: 5,
      })
    ).toHaveLength(5);
    expect(
      drawHourlySlots(noon, 0, 0, undefined, 5, () => 0, {
        maxRunsPerHour: 5,
      })
    ).toHaveLength(0);
    expect(
      drawHourlySlots(noon, 0, 0, undefined, 5, () => 0.999, {
        maxRunsPerHour: 5,
      })
    ).toHaveLength(5);
  });

  it('caps drawn slots cleanly when minGapMinutes physically limits available slots', () => {
    const noon = Date.parse('2026-11-24T12:00:00+09:00');
    const slots = drawHourlySlots(noon, 0, 0, undefined, 25, () => 0.5, {
      minRunsPerHour: 6,
      maxRunsPerHour: 8,
    });
    expect(slots.length).toBeLessThanOrEqual(3);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i] - slots[i - 1]).toBeGreaterThanOrEqual(25);
    }
  });

  it('persists no-response backoff across store restart', async () => {
    const dir = createTempDir();
    const nowMs = Date.parse('2026-11-24T12:00:00+09:00');
    const filePath = join(dir, 'aichat-wander.json');
    const first = new WanderStore({ filePath, now: () => nowMs });

    await first.recordNoResponse('@alice', nowMs + 12 * 3_600_000, nowMs);

    const restarted = new WanderStore({ filePath, now: () => nowMs });
    expect((await restarted.load()).userNoResponseUntil['@alice']).toBe(
      nowMs + 12 * 3_600_000
    );
  });
});

describe('WanderRunner', () => {
  it('filters ineligible notes, falls back on LTL_DISABLED, validates reactions, and executes reply without #aichat', async () => {
    const dir = createTempDir();
    const nowMs = Date.parse('2026-11-24T12:00:00+09:00');
    const db = new loki('wander-test');
    const history = new ChatHistoryRepository(
      db.addCollection<AiChatHist>('aichatHist', {
        indices: ['sessionId', 'postId', 'originalNoteId', 'chatUserId'],
      })
    );

    const affinityStore = new AffinityStore({
      filePath: join(dir, 'aichat-affinity.json'),
      now: () => nowMs,
    });
    const emojiCatalog = new EmojiCatalog({
      cacheFilePath: join(dir, 'aichat-emojis-cache.json'),
      fetchEmojis: async () => [
        { name: 'arigato', aliases: [], category: '挨拶' },
        { name: 'local_only', aliases: [], category: '他', localOnly: true },
      ],
      now: () => nowMs,
    });
    const playbookLoader = new PlaybookLoader({
      filePath: join(dir, 'PLAYBOOK.md'),
    });
    const wanderStore = new WanderStore({
      filePath: join(dir, 'aichat-wander.json'),
      now: () => nowMs,
    });

    const notes: Note[] = [
      makeNote({
        id: 'n-bot',
        user: { id: 'ub', username: 'bot', isBot: true } as User,
      }),
      makeNote({ id: 'n-cw', cw: '閲覧注意' }),
      makeNote({ id: 'n-priv', visibility: 'followers' }),
      makeNote({ id: 'n-reacted', myReaction: '👍' }),
      makeNote({
        id: 'n-old',
        createdAt: new Date(nowMs - 240 * 60_000).toISOString(),
      }),
      makeNote({
        id: 'n-remote',
        userId: 'u-remote',
        user: {
          id: 'u-remote',
          username: 'bob',
          host: 'other.example',
          isBot: false,
        } as User,
        text: 'リモートからこんにちは！',
      }),
      makeNote({
        id: 'n-local',
        userId: 'u-local',
        user: {
          id: 'u-local',
          username: 'carol',
          host: null,
          isBot: false,
        } as User,
        text: '午後の紅茶がおいしいです',
      }),
    ];

    const posts: PostParam[] = [];
    const reactions: Array<{ noteId: string; emoji: string }> = [];
    const subscriptions: Array<{ key: string; noteId: string }> = [];

    const runner = new WanderRunner({
      api: async <T>(endpoint: string): Promise<T> => {
        if (endpoint === 'notes/local-timeline') {
          throw new Error('LTL_DISABLED');
        }
        return notes as unknown as T;
      },
      post: async (param) => {
        posts.push(param);
        return { id: `created-${posts.length}` } as Note;
      },
      react: async (noteId, emoji) => {
        reactions.push({ noteId, emoji });
        return true;
      },
      lookupFriend: () => null,
      isFollowing: async () => true,
      isMasterUser: () => false,
      affinityStore,
      emojiCatalog,
      playbookLoader,
      wanderStore,
      history,
      subscribeReply: (key, _isChat, noteId) => {
        subscriptions.push({ key, noteId });
      },
      selfUserId: 'self-ai',
      postNotPublic: true,
      config: {
        timelines: ['local'],
        replyProbability: 1,
        postProbability: 0,
        maxReactionsPerRun: 3,
      },
      now: () => nowMs,
      // rng: 0.25 -> sampleReactionBudget(0.25) = 1
      rng: () => 0.25,
      callLlm: async (_sys, userPayload) => {
        const parsed = JSON.parse(userPayload) as {
          candidates: Array<{ index: number; acct: string }>;
        };
        // 不適格な5件は候補に含まれず、2件だけが渡される
        expect(parsed.candidates).toHaveLength(2);
        const remoteIdx = parsed.candidates.find((c) =>
          c.acct.includes('other.example')
        )!.index;
        const localIdx = parsed.candidates.find(
          (c) => c.acct === '@carol'
        )!.index;
        return {
          reactions: [{ index: remoteIdx, emoji: ':local_only:' }],
          reply: {
            index: localIdx,
            text: '紅茶いいですね！',
            reaction: ':arigato:',
            delta: 1,
          },
          post: { text: '返信優先のため投稿されない独り言' },
        };
      },
    });

    await runner.runWanderNow();

    // リモートへの localOnly 絵文字はフォールバック '👍' に置換される。
    // 抽選済み予算は1件なので、返信に付随するリアクションは送信されない。
    expect(reactions).toEqual([{ noteId: 'n-remote', emoji: '👍' }]);
    // リプライは1件のみで postNotPublic を尊重し #aichat や @carol を付けない
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      replyId: 'n-local',
      visibility: 'home',
      text: '紅茶いいですね！',
    });
    expect(subscriptions).toHaveLength(1);
    expect(subscriptions[0].noteId).toBe('created-1');

    // wander リプライではメモ(notes)を変更しない
    const carolAffinity = await affinityStore.getEntry(
      { id: 'u-local', username: 'carol', host: null },
      { isMaster: false }
    );
    expect(carolAffinity.score).toBe(1);
    expect(carolAffinity.notes).toBe('');
  });

  it('forwards minRunsPerHour and maxRunsPerHour from WanderRunner.runTick()', async () => {
    const nowMs = Date.parse('2026-11-24T12:00:00+09:00');
    const makeRunner = (
      dir: string,
      wanderCfg: {
        minGapMinutes?: number;
        minRunsPerHour?: number;
        maxRunsPerHour?: number;
      },
      onCall: () => void
    ) => {
      const db = new loki('wander-tick-test');
      const history = new ChatHistoryRepository(
        db.addCollection<AiChatHist>('aichatHist', {
          indices: ['sessionId', 'postId', 'originalNoteId', 'chatUserId'],
        })
      );
      return new WanderRunner({
        api: async <T>(): Promise<T> => {
          onCall();
          return [] as unknown as T;
        },
        post: async () => ({ id: 'posted-1' }) as Note,
        react: async () => true,
        lookupFriend: () => null,
        isFollowing: async () => true,
        isMasterUser: () => false,
        affinityStore: new AffinityStore({
          filePath: join(dir, 'aichat-affinity.json'),
          now: () => nowMs,
        }),
        emojiCatalog: new EmojiCatalog({
          cacheFilePath: join(dir, 'aichat-emojis-cache.json'),
          fetchEmojis: async () => [],
          now: () => nowMs,
        }),
        playbookLoader: new PlaybookLoader({
          filePath: join(dir, 'PLAYBOOK.md'),
        }),
        wanderStore: new WanderStore({
          filePath: join(dir, 'aichat-wander.json'),
          now: () => nowMs,
        }),
        history,
        subscribeReply: () => {},
        selfUserId: 'self-ai',
        config: {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          replyProbability: 0,
          postProbability: 0,
          maxReactionsPerRun: 0,
          ...wanderCfg,
        },
        now: () => nowMs,
        rng: () => 0.5,
      });
    };

    let skippedCalls = 0;
    const skipRunner = makeRunner(
      createTempDir(),
      { minGapMinutes: 10, minRunsPerHour: 0, maxRunsPerHour: 0 },
      () => {
        skippedCalls++;
      }
    );
    await skipRunner.runTick();
    expect(skippedCalls).toBe(0);

    let executedCalls = 0;
    const execRunner = makeRunner(
      createTempDir(),
      { minGapMinutes: 5, minRunsPerHour: 12, maxRunsPerHour: 12 },
      () => {
        executedCalls++;
      }
    );
    await execRunner.runTick();
    expect(executedCalls).toBe(1);
  });
});
