import { getZonedParts } from '@/services/clock.js';

export type WanderScheduleState = {
  hour?: string;
  slots?: number[];
  lastRunAt?: number;
};

export type WanderSchedulerOptions = {
  activeHoursStart?: number;
  activeHoursEnd?: number;
  minGapMinutes?: number;
  minRunsPerHour?: number;
  maxRunsPerHour?: number;
};

export type WanderScheduleDecision = {
  run: boolean;
  reason: 'outside_active_hours' | 'slot' | 'not_slot' | 'min_gap';
  state: WanderScheduleState;
};

const TICK_MINUTES = 5;
const MAX_RUNS_PER_HOUR = 60 / TICK_MINUTES;
const DEFAULT_MAX_RUNS_PER_HOUR = 3;
const HOUR_WEIGHTS: readonly [number, number][] = [
  [0, 20],
  [1, 40],
  [2, 30],
  [3, 10],
];

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

export function isWithinActiveHours(
  hour: number,
  start: number,
  end: number
): boolean {
  if (start <= end) {
    return hour >= start && hour <= end;
  }
  return hour >= start || hour <= end;
}

function pickWeightedCount(rng: () => number): number {
  const total = HOUR_WEIGHTS.reduce((sum, [, w]) => sum + w, 0);
  let r = rng() * total;
  for (const [count, weight] of HOUR_WEIGHTS) {
    r -= weight;
    if (r < 0) return count;
  }
  return 1;
}

/**
 * 1時間あたりの巡回回数を抽選する。
 * min/max 両方未指定時は従来の重み付き確率（0〜3回）を維持し、片側または両側指定時は範囲内で一様抽選する。
 */
function pickSlotCount(
  rng: () => number,
  minRunsPerHour?: number,
  maxRunsPerHour?: number
): number {
  if (minRunsPerHour === undefined && maxRunsPerHour === undefined) {
    return pickWeightedCount(rng);
  }
  const rawMin =
    minRunsPerHour !== undefined && Number.isFinite(minRunsPerHour)
      ? Math.trunc(minRunsPerHour)
      : 0;
  const min = Math.max(0, Math.min(MAX_RUNS_PER_HOUR, rawMin));
  const rawMax =
    maxRunsPerHour !== undefined && Number.isFinite(maxRunsPerHour)
      ? Math.trunc(maxRunsPerHour)
      : Math.max(DEFAULT_MAX_RUNS_PER_HOUR, min);
  const max = Math.max(min, Math.min(MAX_RUNS_PER_HOUR, rawMax));
  if (min === max) return min;
  return Math.min(max, min + Math.floor(rng() * (max - min + 1)));
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

export function drawHourlySlots(
  nowMs: number,
  currentMinute: number,
  currentSecond: number,
  lastRunAt: number | undefined,
  minGapMinutes: number,
  rng: () => number,
  runsBounds?: { minRunsPerHour?: number; maxRunsPerHour?: number }
): number[] {
  const k = pickSlotCount(
    rng,
    runsBounds?.minRunsPerHour,
    runsBounds?.maxRunsPerHour
  );
  if (k <= 0) return [];

  const tickMinute = Math.floor(currentMinute / TICK_MINUTES) * TICK_MINUTES;
  const msWithinHour =
    currentMinute * 60_000 +
    currentSecond * 1000 +
    new Date(nowMs).getMilliseconds();
  const hourStartMs = nowMs - msWithinHour;

  let candidates: number[] = [];
  for (let m = tickMinute; m < 60; m += TICK_MINUTES) {
    candidates.push(m);
  }

  if (lastRunAt != null) {
    const minGapMs = minGapMinutes * 60_000;
    candidates = candidates.filter(
      (m) => hourStartMs + m * 60_000 - lastRunAt >= minGapMs
    );
  }

  shuffle(candidates, rng);
  const slots: number[] = [];
  for (const m of candidates) {
    if (slots.length >= k) break;
    if (slots.every((s) => Math.abs(m - s) >= minGapMinutes)) {
      slots.push(m);
    }
  }
  return slots.sort((a, b) => a - b);
}

/**
 * mugi-misskey ADR 0002 に準拠したランダム時刻 TL 巡回スケジューラ。
 * 毎時最初のティックでその時間のスロット(既定は 0〜3 回の重み付き抽選、minRunsPerHour / maxRunsPerHour 指定時はその範囲で一様抽選)を抽選し、最短間隔を保証する。
 */
export function decideWanderTick(
  nowMs: number,
  state: WanderScheduleState,
  options: WanderSchedulerOptions = {},
  rng: () => number = Math.random
): WanderScheduleDecision {
  const startHour = options.activeHoursStart ?? 9;
  const endHour = options.activeHoursEnd ?? 23;
  const minGapMinutes = options.minGapMinutes ?? 10;

  const parts = getZonedParts(new Date(nowMs), 'Asia/Tokyo');
  if (!isWithinActiveHours(parts.hour, startHour, endHour)) {
    return {
      run: false,
      reason: 'outside_active_hours',
      state: { ...state },
    };
  }

  const tickMinute = Math.floor(parts.minute / TICK_MINUTES) * TICK_MINUTES;
  const hourKey = `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}T${pad2(parts.hour)}`;
  const lastRunAt = state.lastRunAt;

  let nextState: WanderScheduleState;
  if (state.hour !== hourKey || !Array.isArray(state.slots)) {
    nextState = {
      hour: hourKey,
      slots: drawHourlySlots(
        nowMs,
        parts.minute,
        parts.second,
        lastRunAt,
        minGapMinutes,
        rng,
        {
          minRunsPerHour: options.minRunsPerHour,
          maxRunsPerHour: options.maxRunsPerHour,
        }
      ),
      lastRunAt,
    };
  } else {
    nextState = {
      hour: state.hour,
      slots: [...state.slots],
      lastRunAt,
    };
  }

  if (nextState.slots!.includes(tickMinute)) {
    if (lastRunAt != null && nowMs - lastRunAt < minGapMinutes * 60_000) {
      return {
        run: false,
        reason: 'min_gap',
        state: nextState,
      };
    }
    nextState.lastRunAt = nowMs;
    return {
      run: true,
      reason: 'slot',
      state: nextState,
    };
  }

  return {
    run: false,
    reason: 'not_slot',
    state: nextState,
  };
}
