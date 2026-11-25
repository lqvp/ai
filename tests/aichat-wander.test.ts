import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    expect(slots).toHaveLength(3);
    for (let i = 1; i < slots.length; i++) {
      expect(slots[i] - slots[i - 1]).toBeGreaterThanOrEqual(25);
    }
  });

  it('guarantees feasible k slots regardless of shuffle order (Devin/CodeRabbit regression)', () => {
    const noon = Date.parse('2026-11-24T12:00:00+09:00');

    // Devin 指摘の例: rng = () => 0.19 でも 6 枠を確保できる
    const devinCase = decideWanderTick(
      noon,
      {},
      {
        activeHoursStart: 9,
        activeHoursEnd: 23,
        minGapMinutes: 10,
        minRunsPerHour: 6,
        maxRunsPerHour: 6,
      },
      () => 0.19
    );
    expect(devinCase.state.slots).toHaveLength(6);
    for (let i = 1; i < devinCase.state.slots!.length; i++) {
      expect(
        devinCase.state.slots![i] - devinCase.state.slots![i - 1]
      ).toBeGreaterThanOrEqual(10);
    }

    // CodeRabbit 指摘の候補順: Fisher-Yates で先頭が [5, 20, 35, 50] になる RNG 列でも 6 枠を確保できる
    const jValues = [11, 9, 8, 6, 5, 3, 2, 0, 3, 2, 0];
    let step = 0;
    const coderabbitRng = () => {
      const i = 11 - step;
      const j = jValues[step++] ?? 0;
      return (j + 0.5) / (i + 1);
    };
    const coderabbitSlots = drawHourlySlots(
      noon,
      0,
      0,
      undefined,
      10,
      coderabbitRng,
      { minRunsPerHour: 6, maxRunsPerHour: 6 }
    );
    expect(coderabbitSlots).toHaveLength(6);
    for (let i = 1; i < coderabbitSlots.length; i++) {
      expect(
        coderabbitSlots[i] - coderabbitSlots[i - 1]
      ).toBeGreaterThanOrEqual(10);
    }

    // 多数の乱数シードでも (k=6, minGap=10) は常に 6 枠、(min=6..8, minGap=25) は最大値 3 枠に到達する
    const makeLcg = (seed: number) => {
      let state = seed >>> 0;
      return () => {
        state = (1664525 * state + 1013904223) >>> 0;
        return state / 0x100000000;
      };
    };
    for (let seed = 1; seed <= 50; seed++) {
      const slots6 = drawHourlySlots(noon, 0, 0, undefined, 10, makeLcg(seed), {
        minRunsPerHour: 6,
        maxRunsPerHour: 6,
      });
      expect(slots6).toHaveLength(6);
      for (let i = 1; i < slots6.length; i++) {
        expect(slots6[i] - slots6[i - 1]).toBeGreaterThanOrEqual(10);
      }

      const slots3 = drawHourlySlots(noon, 0, 0, undefined, 25, makeLcg(seed), {
        minRunsPerHour: 6,
        maxRunsPerHour: 8,
      });
      expect(slots3).toHaveLength(3);
      for (let i = 1; i < slots3.length; i++) {
        expect(slots3[i] - slots3[i - 1]).toBeGreaterThanOrEqual(25);
      }
    }
  });

  it('recalculates remaining slots on mid-hour bounds change while keeping unchanged bounds stable across restarts', async () => {
    const t1200 = Date.parse('2026-11-24T12:00:00+09:00');
    const t1215 = Date.parse('2026-11-24T12:15:00+09:00');
    const t1220 = Date.parse('2026-11-24T12:20:00+09:00');

    // 1. 変更なしの再起動では保存済みスロットを維持する
    {
      const dir = createTempDir();
      const filePath = join(dir, 'aichat-wander.json');
      const store1 = new WanderStore({ filePath, now: () => t1200 });
      const d0 = await store1.checkAndCommitScheduleTick(
        t1200,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 2,
          maxRunsPerHour: 2,
        },
        () => 0.5
      );
      const initialSlots = d0.state.slots!;
      expect(initialSlots).toHaveLength(2);

      const store2 = new WanderStore({ filePath, now: () => t1220 });
      const dAfter = await store2.checkAndCommitScheduleTick(
        t1220,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 2,
          maxRunsPerHour: 2,
        },
        () => 0.1
      );
      expect(dAfter.state.slots).toEqual(initialSlots);
    }

    // 2. 12:15 実行後に 12:20 で maxRunsPerHour = 0 に変更して再起動すると、残りの枠でも発火しない
    {
      const dir = createTempDir();
      const filePath = join(dir, 'aichat-wander.json');
      const store1 = new WanderStore({ filePath, now: () => t1215 });
      const seeded = await store1.checkAndCommitScheduleTick(
        t1215,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 2,
          maxRunsPerHour: 2,
        },
        () => 0.5
      );
      // 12:15 に強制発火させた状態を構成（[15, 35] のうち 15 が実行済みで 35 が残っている想定）
      const storeOverride = new WanderStore({ filePath, now: () => t1215 });
      await storeOverride.load();
      const dec15 = decideWanderTick(
        t1215,
        {
          hour: '2026-11-24T12',
          slots: [15, 35],
          executedSlots: [],
          boundsKey: '2..2',
        },
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 2,
          maxRunsPerHour: 2,
        }
      );
      expect(dec15.run).toBe(true);
      expect(seeded.state.hour).toBe('2026-11-24T12');

      // ストアに 12:15 実行済み ([15, 35], boundsKey="2..2") を直接保存する代わりに runTick 相当で再現
      const dec20Zero = decideWanderTick(
        t1220,
        dec15.state,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 0,
          maxRunsPerHour: 0,
        },
        () => 0.5
      );
      expect(dec20Zero.run).toBe(false);
      expect(dec20Zero.state.slots).toEqual([15]);
      expect(dec20Zero.state.boundsKey).toBe('0..0');

      const t1235 = Date.parse('2026-11-24T12:35:00+09:00');
      const dec35Zero = decideWanderTick(
        t1235,
        dec20Zero.state,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 0,
          maxRunsPerHour: 0,
        },
        () => 0.5
      );
      expect(dec35Zero.run).toBe(false);
      expect(dec35Zero.reason).toBe('not_slot');
    }

    // 3. WanderStore 経由で 12:15 発火後に 12:20 で min=3, max=3 へ引き上げると、合計3枠になるよう残余2枠が追加される
    {
      const dir = createTempDir();
      const filePath = join(dir, 'aichat-wander.json');
      const store1 = new WanderStore({ filePath, now: () => t1215 });
      // rng=0 なら候補先頭やシャッフル順に関わらずまず 12:15 を引くとは限らないため、min=12,max=12 から絞る/12:15 で実行済みを作る
      // まず 12:15 に 1 枠以上を含めて確実に実行される min=12, max=12 で起動 -> 12:15 で発火した直後に 2..2 や 3..3 を試す代わりに
      // 12:15 に bounds=1..1 で 12:15 に発火させるため、12:15 が選ばれる rng を用いるか 12:15 に 12:15 のみの状態を作る
      const decSeed = await store1.checkAndCommitScheduleTick(
        t1215,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 1,
          maxRunsPerHour: 1,
        },
        // i=8..1 (candidates = [15,20,25,30,35,40,45,50,55], len=9): すべて rng=0 なら 15 が最後に残り index 0 (つまり 20..55 が先に出るが k=1 なので先頭が選ばれる)
        // i=8..1 ですべて rng=0.999 を渡せば無交換なので先頭は 15 のまま!
        () => 0.999
      );
      expect(decSeed.run).toBe(true);
      expect(decSeed.state.slots).toEqual([15]);

      const store2 = new WanderStore({ filePath, now: () => t1220 });
      const decIncreased = await store2.checkAndCommitScheduleTick(
        t1220,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 3,
          maxRunsPerHour: 3,
        },
        () => 0.5
      );
      expect(decIncreased.state.slots).toHaveLength(3);
      expect(decIncreased.state.slots![0]).toBe(15);
      expect(decIncreased.state.slots![1]).toBeGreaterThanOrEqual(25);
      expect(
        decIncreased.state.slots![2] - decIncreased.state.slots![1]
      ).toBeGreaterThanOrEqual(10);

      // さらに再起動した store3 で同じ時刻に 0..0 へ変更すると即座に残り枠が消える
      const store3 = new WanderStore({ filePath, now: () => t1220 });
      const decSuppressed = await store3.checkAndCommitScheduleTick(
        t1220,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 0,
          maxRunsPerHour: 0,
        },
        () => 0.5
      );
      expect(decSuppressed.run).toBe(false);
      expect(decSuppressed.state.slots).toEqual([15]);
      expect((await store3.load()).schedule).toEqual({
        hour: '2026-11-24T12',
        slots: [15],
        executedSlots: [15],
        boundsKey: '0..0',
      });
    }
  });

  it('tracks executedSlots accurately across skipped min_gap ticks and handles sub-tick offsets on mid-hour restarts', async () => {
    // 1. min_gap で見送られた途中の枠を実行済みと数えない + executedSlots 無しの旧データ移行でも過大計上しない
    {
      const t1200_01 = Date.parse('2026-11-24T12:00:01+09:00');
      const t1210_009 = Date.parse('2026-11-24T12:10:00.900+09:00');
      const t1220_01 = Date.parse('2026-11-24T12:20:01+09:00');
      const t1235_00 = Date.parse('2026-11-24T12:35:00+09:00');

      const initialState = {
        hour: '2026-11-24T12',
        slots: [0, 10, 20],
        executedSlots: [],
        boundsKey: '3..3',
      };
      const d0 = decideWanderTick(
        t1200_01,
        initialState,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 3,
          maxRunsPerHour: 3,
        },
        () => 0.5
      );
      expect(d0.run).toBe(true);
      expect(d0.state.executedSlots).toEqual([0]);

      const d10 = decideWanderTick(
        t1210_009,
        d0.state,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 3,
          maxRunsPerHour: 3,
        },
        () => 0.5
      );
      expect(d10.run).toBe(false);
      expect(d10.reason).toBe('min_gap');
      expect(d10.state.executedSlots).toEqual([0]);

      const d20 = decideWanderTick(
        t1220_01,
        d10.state,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 3,
          maxRunsPerHour: 3,
        },
        () => 0.5
      );
      expect(d20.run).toBe(true);
      expect(d20.state.executedSlots).toEqual([0, 20]);

      // 12:35 再起動で固定 4 回へ増やすと、実績 2 回を差し引いて残り 2 枠が追加される
      const d35 = decideWanderTick(
        t1235_00,
        d20.state,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 4,
          maxRunsPerHour: 4,
        },
        () => 0.5
      );
      expect(d35.state.slots).toHaveLength(4);
      expect(d35.state.slots!.slice(0, 2)).toEqual([0, 20]);
      expect(d35.state.slots!.slice(2).every((s) => s >= 35 && s <= 55)).toBe(
        true
      );
      expect(d35.state.executedSlots).toEqual(d35.run ? [0, 20, 35] : [0, 20]);

      // executedSlots が無い旧データからの移行時は、lastRunAt 以前の予定枠を保守的に消化扱いとしつつ履歴を捏造せず上限を超えない
      const t1210_00 = Date.parse('2026-11-24T12:10:00+09:00');
      const t1220_00 = Date.parse('2026-11-24T12:20:00+09:00');
      const t1225_00 = Date.parse('2026-11-24T12:25:00+09:00');
      const legacyDec = decideWanderTick(
        t1225_00,
        {
          hour: '2026-11-24T12',
          slots: [0, 10],
          lastRunAt: t1210_00,
        },
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 2,
          maxRunsPerHour: 2,
        },
        () => 0.5
      );
      expect(legacyDec.run).toBe(false);
      expect(legacyDec.state.slots).toEqual([0, 10]);
      expect(legacyDec.state.executedSlots).toBeUndefined();

      // 予定表に lastRunAt 対応枠が含まれない旧データでも、executedSlots を捏造せず1回分を上限から差し引く
      const unscheduledDir = createTempDir();
      const unscheduledPath = join(unscheduledDir, 'aichat-wander.json');
      writeFileSync(
        unscheduledPath,
        JSON.stringify({
          version: 1,
          lastPostAt: null,
          lastRunAt: t1210_00,
          schedule: { hour: '2026-11-24T12', slots: [45] },
          recent: [],
          actedNoteIds: [],
          userLastReplyAt: {},
          userLastReactAt: {},
          userNoResponseUntil: {},
          recentEmojis: [],
        }),
        'utf8'
      );
      const unscheduledStore = new WanderStore({
        filePath: unscheduledPath,
        now: () => t1225_00,
      });
      const unscheduledMigrated =
        await unscheduledStore.checkAndCommitScheduleTick(
          t1225_00,
          {
            activeHoursStart: 9,
            activeHoursEnd: 23,
            minGapMinutes: 10,
            minRunsPerHour: 2,
            maxRunsPerHour: 2,
          },
          () => 0.5
        );
      expect(unscheduledMigrated.state.executedSlots).toBeUndefined();
      expect(unscheduledMigrated.state.slots).toHaveLength(2);
      expect(unscheduledMigrated.state.slots![0]).toBe(10);
      expect(unscheduledMigrated.state.slots![1]).toBeGreaterThanOrEqual(25);
      const persistedUnscheduled = (await unscheduledStore.load()).schedule;
      expect(persistedUnscheduled?.executedSlots).toBeUndefined();
      expect(persistedUnscheduled?.slots).toEqual(
        unscheduledMigrated.state.slots
      );

      // WanderStore 経由でも、未変更の再起動を挟んでから 2..2 へ移行しても上限を超えず executedSlots を捏造しない
      const legacyDir = createTempDir();
      const legacyPath = join(legacyDir, 'aichat-wander.json');
      writeFileSync(
        legacyPath,
        JSON.stringify({
          version: 1,
          lastPostAt: null,
          lastRunAt: t1210_00,
          schedule: { hour: '2026-11-24T12', slots: [0, 10, 45] },
          recent: [],
          actedNoteIds: [],
          userLastReplyAt: {},
          userLastReactAt: {},
          userNoResponseUntil: {},
          recentEmojis: [],
        }),
        'utf8'
      );
      const legacyStore1 = new WanderStore({
        filePath: legacyPath,
        now: () => t1220_00,
      });
      const legacyUnchanged = await legacyStore1.checkAndCommitScheduleTick(
        t1220_00,
        { activeHoursStart: 9, activeHoursEnd: 23, minGapMinutes: 10 },
        () => 0.5
      );
      expect(legacyUnchanged.run).toBe(false);
      expect(legacyUnchanged.state.executedSlots).toBeUndefined();
      expect((await legacyStore1.load()).schedule).toEqual({
        hour: '2026-11-24T12',
        slots: [0, 10, 45],
      });

      const legacyStore2 = new WanderStore({
        filePath: legacyPath,
        now: () => t1225_00,
      });
      const legacyMigrated = await legacyStore2.checkAndCommitScheduleTick(
        t1225_00,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 2,
          maxRunsPerHour: 2,
        },
        () => 0.5
      );
      expect(legacyMigrated.run).toBe(false);
      expect(legacyMigrated.state.slots).toEqual([0, 10]);
      expect(legacyMigrated.state.executedSlots).toBeUndefined();
      expect((await legacyStore2.load()).schedule).toEqual({
        hour: '2026-11-24T12',
        slots: [0, 10],
        boundsKey: '2..2',
      });

      // lastRunAt が前の時間帯にあり当時間帯の実績ゼロが確定できる旧予定は、空配列から追跡を開始して途中の min_gap 見送りを過大計上しない
      const zeroRunDir = createTempDir();
      const zeroRunPath = join(zeroRunDir, 'aichat-wander.json');
      const t1155_00 = Date.parse('2026-11-24T11:55:00+09:00');
      const t1210_zero = Date.parse('2026-11-24T12:10:00+09:00');
      const t1230_zero = Date.parse('2026-11-24T12:30:00+09:00');
      const t1235_zero = Date.parse('2026-11-24T12:35:00+09:00');
      writeFileSync(
        zeroRunPath,
        JSON.stringify({
          version: 1,
          lastPostAt: null,
          lastRunAt: t1155_00,
          schedule: { hour: '2026-11-24T12', slots: [10, 30] },
          recent: [],
          actedNoteIds: [],
          userLastReplyAt: {},
          userLastReactAt: {},
          userNoResponseUntil: {},
          recentEmojis: [],
        }),
        'utf8'
      );

      const zeroStore1 = new WanderStore({
        filePath: zeroRunPath,
        now: () => t1210_zero,
      });
      const zeroSkip = await zeroStore1.checkAndCommitScheduleTick(
        t1210_zero,
        { activeHoursStart: 9, activeHoursEnd: 23, minGapMinutes: 20 },
        () => 0.5
      );
      expect(zeroSkip.run).toBe(false);
      expect(zeroSkip.reason).toBe('min_gap');
      expect(zeroSkip.state.executedSlots).toEqual([]);
      expect((await zeroStore1.load()).schedule?.executedSlots).toEqual([]);

      const zeroRun = await zeroStore1.checkAndCommitScheduleTick(
        t1230_zero,
        { activeHoursStart: 9, activeHoursEnd: 23, minGapMinutes: 20 },
        () => 0.5
      );
      expect(zeroRun.run).toBe(true);
      expect(zeroRun.state.executedSlots).toEqual([30]);

      const zeroStore2 = new WanderStore({
        filePath: zeroRunPath,
        now: () => t1235_zero,
      });
      const zeroMigrated = await zeroStore2.checkAndCommitScheduleTick(
        t1235_zero,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 20,
          minRunsPerHour: 2,
          maxRunsPerHour: 2,
        },
        () => 0.5
      );
      expect(zeroMigrated.state.slots).toHaveLength(2);
      expect(zeroMigrated.state.slots![0]).toBe(30);
      expect(zeroMigrated.state.slots![1]).toBeGreaterThanOrEqual(50);
      expect(zeroMigrated.state.executedSlots).toEqual([30]);
    }

    // 2. 枠の開始から +40s ずれて再起動しても nowMs 基準で最短間隔を満たせば即座に2枠追加実行でき、早着ティックは min_gap で見送られる
    {
      const dir = createTempDir();
      const filePath = join(dir, 'aichat-wander.json');
      const t1235_20 = Date.parse('2026-11-24T12:35:20+09:00');
      const t1245_40 = Date.parse('2026-11-24T12:45:40+09:00');
      const t1255_399 = Date.parse('2026-11-24T12:55:39.900+09:00');
      const t1255_40 = Date.parse('2026-11-24T12:55:40+09:00');

      const store1 = new WanderStore({ filePath, now: () => t1235_20 });
      const d35 = await store1.checkAndCommitScheduleTick(
        t1235_20,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 1,
          maxRunsPerHour: 1,
        },
        () => 0.999
      );
      expect(d35.run).toBe(true);
      expect(d35.state.slots).toEqual([35]);
      expect(d35.state.executedSlots).toEqual([35]);

      const store2 = new WanderStore({ filePath, now: () => t1245_40 });
      const d45 = await store2.checkAndCommitScheduleTick(
        t1245_40,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 3,
          maxRunsPerHour: 3,
        },
        () => 0.5
      );
      expect(d45.run).toBe(true);
      expect(d45.state.slots).toEqual([35, 45, 55]);
      expect(d45.state.executedSlots).toEqual([35, 45]);

      // 見積もりより 0.1s 早く到達した 12:55 ティックは実行時の min_gap ガードで見送られる
      const early55 = decideWanderTick(
        t1255_399,
        d45.state,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 3,
          maxRunsPerHour: 3,
        },
        () => 0.5
      );
      expect(early55.run).toBe(false);
      expect(early55.reason).toBe('min_gap');
      expect(early55.state.executedSlots).toEqual([35, 45]);

      const store3 = new WanderStore({ filePath, now: () => t1255_40 });
      const d55 = await store3.checkAndCommitScheduleTick(
        t1255_40,
        {
          activeHoursStart: 9,
          activeHoursEnd: 23,
          minGapMinutes: 10,
          minRunsPerHour: 3,
          maxRunsPerHour: 3,
        },
        () => 0.5
      );
      expect(d55.run).toBe(true);
      expect(d55.state.executedSlots).toEqual([35, 45, 55]);
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
