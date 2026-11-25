import { getZonedParts } from '@/services/clock.js';

export type WanderScheduleState = {
  hour?: string;
  slots?: number[];
  executedSlots?: number[];
  boundsKey?: string;
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

type ResolvedRunsBounds = {
  min: number;
  max: number;
  key: string;
};

/**
 * minRunsPerHour / maxRunsPerHour を正規化する。両方未指定の場合は undefined を返す。
 */
function resolveRunsBounds(
  minRunsPerHour?: number,
  maxRunsPerHour?: number
): ResolvedRunsBounds | undefined {
  if (minRunsPerHour === undefined && maxRunsPerHour === undefined) {
    return undefined;
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
  return { min, max, key: `${min}..${max}` };
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
  const bounds = resolveRunsBounds(minRunsPerHour, maxRunsPerHour);
  if (!bounds) {
    return pickWeightedCount(rng);
  }
  if (bounds.min === bounds.max) return bounds.min;
  return Math.min(
    bounds.max,
    bounds.min + Math.floor(rng() * (bounds.max - bounds.min + 1))
  );
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

/**
 * 昇順候補から minGapMinutes 以上の間隔を保って選択できる最大スロット数を返す。
 */
function maxDisjointSlots(
  sortedCandidates: readonly number[],
  minGapMinutes: number
): number {
  let count = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (const m of sortedCandidates) {
    if (m - last >= minGapMinutes) {
      count++;
      last = m;
    }
  }
  return count;
}

/**
 * 候補リストから minGapMinutes 以上の間隔を満たしつつ、目標件数（上限は配置可能最大数）を確実に満たすようランダムに選択する。
 */
function selectDisjointSlots(
  sortedCandidates: readonly number[],
  requestedCount: number,
  minGapMinutes: number,
  rng: () => number
): number[] {
  if (requestedCount <= 0 || sortedCandidates.length === 0) return [];
  const targetCount = Math.min(
    requestedCount,
    maxDisjointSlots(sortedCandidates, minGapMinutes)
  );
  if (targetCount <= 0) return [];

  const shuffled = shuffle([...sortedCandidates], rng);
  const slots: number[] = [];
  for (let i = 0; i < shuffled.length; i++) {
    if (slots.length >= targetCount) break;
    const m = shuffled[i];
    if (!slots.every((s) => Math.abs(m - s) >= minGapMinutes)) continue;

    // 残余候補もすべて既選スロット・m の双方と間隔を満たすため、区間グラフ上の貪欲最大数で到達可能性を正確に判定できる
    const remainingCompatible = shuffled
      .slice(i + 1)
      .filter(
        (x) =>
          Math.abs(x - m) >= minGapMinutes &&
          slots.every((s) => Math.abs(x - s) >= minGapMinutes)
      )
      .sort((a, b) => a - b);

    if (
      slots.length + 1 + maxDisjointSlots(remainingCompatible, minGapMinutes) >=
      targetCount
    ) {
      slots.push(m);
    }
  }
  return slots.sort((a, b) => a - b);
}

/**
 * 開始ティック以降で lastRunAt との最短間隔を満たす候補時刻（分）を昇順で返す。
 * 各候補の予定評価時刻は実際の呼び出し基準時刻（nowMs）から 5 分刻みで算出する。
 */
function buildRemainingTickCandidates(
  nowMs: number,
  currentTickMinute: number,
  startTickMinute: number,
  lastRunAt: number | undefined,
  minGapMinutes: number
): number[] {
  const candidates: number[] = [];
  for (let m = startTickMinute; m < 60; m += TICK_MINUTES) {
    candidates.push(m);
  }
  if (lastRunAt != null) {
    const minGapMs = minGapMinutes * 60_000;
    return candidates.filter(
      (m) => nowMs + (m - currentTickMinute) * 60_000 - lastRunAt >= minGapMs
    );
  }
  return candidates;
}

type HourProgress = {
  /** 確実に実行されたと記録されているスロット一覧（旧データでは undefined を維持し履歴を捏造しない） */
  trackedExecutedSlots: number[] | undefined;
  /** 上限超過を防ぐために差し引く消化スロット（tracked がある場合はその一覧、旧データでは lastRunAt 以前の予定枠すべて） */
  accountedSlots: number[];
};

/**
 * 同一時間帯の進捗を解決する。
 * executedSlots を持たない旧データでは、上限超過を防ぐため lastRunAt 以前に予定されていた枠を保守的に消化扱いとしつつ、executedSlots 自体は捏造しない。
 */
function resolveHourProgress(
  state: WanderScheduleState,
  hourStartMs: number,
  nowMs: number,
  tickMinute: number
): HourProgress {
  if (Array.isArray(state.executedSlots)) {
    const unique = new Set<number>();
    for (const s of state.executedSlots) {
      if (Number.isInteger(s) && s >= 0 && s <= tickMinute) {
        unique.add(s);
      }
    }
    const tracked = [...unique].sort((a, b) => a - b);
    return { trackedExecutedSlots: tracked, accountedSlots: tracked };
  }
  if (
    state.lastRunAt != null &&
    state.lastRunAt >= hourStartMs &&
    state.lastRunAt <= nowMs &&
    Array.isArray(state.slots)
  ) {
    const possible = [
      ...new Set(
        state.slots.filter(
          (s) =>
            Number.isInteger(s) &&
            s >= 0 &&
            s <= tickMinute &&
            hourStartMs + s * 60_000 <= state.lastRunAt!
        )
      ),
    ].sort((a, b) => a - b);
    return { trackedExecutedSlots: undefined, accountedSlots: possible };
  }
  return { trackedExecutedSlots: undefined, accountedSlots: [] };
}

export function drawHourlySlots(
  nowMs: number,
  currentMinute: number,
  _currentSecond: number,
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

  const candidates = buildRemainingTickCandidates(
    nowMs,
    tickMinute,
    tickMinute,
    lastRunAt,
    minGapMinutes
  );

  return selectDisjointSlots(candidates, k, minGapMinutes, rng);
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
  const msWithinHour =
    parts.minute * 60_000 +
    parts.second * 1000 +
    new Date(nowMs).getMilliseconds();
  const hourStartMs = nowMs - msWithinHour;
  const lastRunAt = state.lastRunAt;
  const resolvedBounds = resolveRunsBounds(
    options.minRunsPerHour,
    options.maxRunsPerHour
  );
  const currentBoundsKey = resolvedBounds?.key;

  let nextState: WanderScheduleState;
  let completedThisTick = false;
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
      executedSlots: [],
      ...(currentBoundsKey !== undefined
        ? { boundsKey: currentBoundsKey }
        : {}),
      lastRunAt,
    };
  } else if ((state.boundsKey ?? undefined) !== currentBoundsKey) {
    // 設定変更を伴う同一時間帯の再起動時は、記録済みまたは保守的消化スロットを差し引いて残余枠を再計算する
    const { trackedExecutedSlots, accountedSlots } = resolveHourProgress(
      state,
      hourStartMs,
      nowMs,
      tickMinute
    );
    completedThisTick = accountedSlots.includes(tickMinute);

    const totalTarget = pickSlotCount(
      rng,
      options.minRunsPerHour,
      options.maxRunsPerHour
    );
    const remainingTarget = Math.max(0, totalTarget - accountedSlots.length);
    let futureSlots: number[] = [];
    if (remainingTarget > 0) {
      const startTick = completedThisTick
        ? tickMinute + TICK_MINUTES
        : tickMinute;
      const futureCandidates = buildRemainingTickCandidates(
        nowMs,
        tickMinute,
        startTick,
        lastRunAt,
        minGapMinutes
      );
      futureSlots = selectDisjointSlots(
        futureCandidates,
        remainingTarget,
        minGapMinutes,
        rng
      );
    }

    nextState = {
      hour: hourKey,
      slots: [...accountedSlots, ...futureSlots].sort((a, b) => a - b),
      ...(trackedExecutedSlots !== undefined
        ? { executedSlots: trackedExecutedSlots }
        : {}),
      ...(currentBoundsKey !== undefined
        ? { boundsKey: currentBoundsKey }
        : {}),
      lastRunAt,
    };
  } else {
    const { trackedExecutedSlots, accountedSlots } = resolveHourProgress(
      state,
      hourStartMs,
      nowMs,
      tickMinute
    );
    completedThisTick = accountedSlots.includes(tickMinute);
    nextState = {
      hour: state.hour,
      slots: [...state.slots],
      ...(trackedExecutedSlots !== undefined
        ? { executedSlots: trackedExecutedSlots }
        : {}),
      ...(currentBoundsKey !== undefined
        ? { boundsKey: currentBoundsKey }
        : {}),
      lastRunAt,
    };
  }

  if (!completedThisTick && nextState.slots!.includes(tickMinute)) {
    if (lastRunAt != null && nowMs - lastRunAt < minGapMinutes * 60_000) {
      return {
        run: false,
        reason: 'min_gap',
        state: nextState,
      };
    }
    nextState.lastRunAt = nowMs;
    if (Array.isArray(nextState.executedSlots)) {
      nextState.executedSlots = [
        ...new Set([...nextState.executedSlots, tickMinute]),
      ].sort((a, b) => a - b);
    }
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
