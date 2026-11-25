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
import { decideWanderTick } from '../src/modules/aichat/wander-scheduler.js';
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
});
