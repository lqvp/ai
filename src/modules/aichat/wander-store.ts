import { JsonFileStore, stripDangerousKeys } from './json-file-store.js';
import {
  decideWanderTick,
  type WanderScheduleDecision,
  type WanderSchedulerOptions,
} from './wander-scheduler.js';

export type WanderRecentItem = {
  at: string;
  kind: 'react' | 'reply' | 'post' | 'noop';
  targetAcct?: string;
  summary: string;
};

export type WanderState = {
  version: 1;
  lastPostAt: string | null;
  lastRunAt: number | null;
  schedule: { hour: string; slots: number[] } | null;
  recent: WanderRecentItem[];
  actedNoteIds: string[];
  userLastReplyAt: Record<string, number>;
  userLastReactAt: Record<string, number>;
  /** 無反応だったbot起点リプライ後の一時停止期限 */
  userNoResponseUntil: Record<string, number>;
  recentEmojis: string[];
};

const MAX_RECENT = 10;
const MAX_ACTED_NOTES = 100;
const MAX_RECENT_EMOJIS = 5;
const COOLDOWN_RETENTION_MS = 7 * 86_400_000;

function createDefaultWanderState(): WanderState {
  return {
    version: 1,
    lastPostAt: null,
    lastRunAt: null,
    schedule: null,
    recent: [],
    actedNoteIds: [],
    userLastReplyAt: {},
    userLastReactAt: {},
    userNoResponseUntil: {},
    recentEmojis: [],
  };
}

function normalizeTimestampMap(raw: unknown): Record<string, number> {
  if (raw == null || typeof raw !== 'object') return {};
  const out: Record<string, number> = {};
  for (const key of Object.keys(raw)) {
    const val = (raw as Record<string, unknown>)[key];
    if (typeof val === 'number' && Number.isFinite(val) && val > 0) {
      out[key] = val;
    }
  }
  return out;
}

function normalizeWanderState(raw: unknown): WanderState {
  const safe = stripDangerousKeys(raw);
  const obj =
    safe != null && typeof safe === 'object'
      ? (safe as Record<string, unknown>)
      : {};

  const lastPostAt =
    typeof obj.lastPostAt === 'string' &&
    !Number.isNaN(Date.parse(obj.lastPostAt))
      ? obj.lastPostAt
      : null;
  const lastRunAt =
    typeof obj.lastRunAt === 'number' && Number.isFinite(obj.lastRunAt)
      ? obj.lastRunAt
      : null;

  let schedule: { hour: string; slots: number[] } | null = null;
  if (obj.schedule != null && typeof obj.schedule === 'object') {
    const sched = obj.schedule as Record<string, unknown>;
    if (typeof sched.hour === 'string' && Array.isArray(sched.slots)) {
      schedule = {
        hour: sched.hour,
        slots: sched.slots.filter(
          (s): s is number => typeof s === 'number' && Number.isInteger(s)
        ),
      };
    }
  }

  const recent: WanderRecentItem[] = Array.isArray(obj.recent)
    ? obj.recent
        .filter(
          (r): r is Record<string, unknown> =>
            r != null && typeof r === 'object'
        )
        .filter(
          (r) =>
            typeof r.at === 'string' &&
            typeof r.summary === 'string' &&
            (r.kind === 'react' ||
              r.kind === 'reply' ||
              r.kind === 'post' ||
              r.kind === 'noop')
        )
        .map((r) => ({
          at: r.at as string,
          kind: r.kind as WanderRecentItem['kind'],
          ...(typeof r.targetAcct === 'string'
            ? { targetAcct: r.targetAcct }
            : {}),
          summary: String(r.summary).slice(0, 80),
        }))
        .slice(-MAX_RECENT)
    : [];

  const actedNoteIds = Array.isArray(obj.actedNoteIds)
    ? obj.actedNoteIds
        .filter(
          (id): id is string => typeof id === 'string' && id.trim() !== ''
        )
        .slice(-MAX_ACTED_NOTES)
    : [];

  const recentEmojis = Array.isArray(obj.recentEmojis)
    ? obj.recentEmojis
        .filter((e): e is string => typeof e === 'string' && e.trim() !== '')
        .slice(-MAX_RECENT_EMOJIS)
    : [];

  return {
    version: 1,
    lastPostAt,
    lastRunAt,
    schedule,
    recent,
    actedNoteIds,
    userLastReplyAt: normalizeTimestampMap(obj.userLastReplyAt),
    userLastReactAt: normalizeTimestampMap(obj.userLastReactAt),
    userNoResponseUntil: normalizeTimestampMap(obj.userNoResponseUntil),
    recentEmojis,
  };
}

export type RecordWanderActionsParams = {
  nowMs: number;
  lastPostAt?: string;
  recentItems?: WanderRecentItem[];
  actedNoteIds?: string[];
  repliedAccts?: string[];
  reactedAccts?: string[];
  usedEmojis?: string[];
};

/**
 * aichat-wander.json の永続化ストア（行動履歴・クールダウン・時間スロット）。
 */
export class WanderStore {
  private readonly store: JsonFileStore<WanderState>;

  constructor(options: {
    filePath: string;
    log?: (message: string) => void;
    now?: () => number;
  }) {
    this.store = new JsonFileStore<WanderState>({
      filePath: options.filePath,
      createDefault: createDefaultWanderState,
      normalize: normalizeWanderState,
      log: options.log,
      now: options.now,
    });
  }

  public get path(): string {
    return this.store.path;
  }

  public async load(): Promise<WanderState> {
    return this.store.load();
  }

  public async checkAndCommitScheduleTick(
    nowMs: number,
    schedulerOptions: WanderSchedulerOptions,
    rng: () => number
  ): Promise<WanderScheduleDecision> {
    return this.store.update((state) => {
      const decision = decideWanderTick(
        nowMs,
        {
          hour: state.schedule?.hour,
          slots: state.schedule?.slots,
          lastRunAt: state.lastRunAt ?? undefined,
        },
        schedulerOptions,
        rng
      );

      const newSchedule =
        decision.state.hour != null && decision.state.slots != null
          ? { hour: decision.state.hour, slots: decision.state.slots }
          : state.schedule;

      const scheduleChanged =
        newSchedule?.hour !== state.schedule?.hour ||
        JSON.stringify(newSchedule?.slots) !==
          JSON.stringify(state.schedule?.slots);
      const lastRunChanged =
        (decision.state.lastRunAt ?? null) !== state.lastRunAt;

      if (!scheduleChanged && !lastRunChanged) {
        return { next: state, result: decision, write: false };
      }

      return {
        next: {
          ...state,
          lastRunAt: decision.state.lastRunAt ?? null,
          schedule: newSchedule,
        },
        result: decision,
        write: true,
      };
    });
  }

  public async recordNoResponse(
    acct: string,
    untilMs: number,
    nowMs: number
  ): Promise<void> {
    await this.store.update((state) => {
      const userNoResponseUntil: Record<string, number> = {};
      for (const [key, until] of Object.entries(state.userNoResponseUntil)) {
        if (until > nowMs) userNoResponseUntil[key] = until;
      }
      userNoResponseUntil[acct] = untilMs;
      return {
        next: { ...state, userNoResponseUntil },
        result: undefined,
      };
    });
  }

  public async recordActions(
    params: RecordWanderActionsParams
  ): Promise<WanderState> {
    const {
      nowMs,
      lastPostAt,
      recentItems = [],
      actedNoteIds = [],
      repliedAccts = [],
      reactedAccts = [],
      usedEmojis = [],
    } = params;

    return this.store.update((state) => {
      const mergedRecent = [...state.recent, ...recentItems].slice(-MAX_RECENT);

      const actedSet = new Set(state.actedNoteIds);
      for (const id of actedNoteIds) {
        actedSet.delete(id);
        actedSet.add(id);
      }
      const nextActed = [...actedSet].slice(-MAX_ACTED_NOTES);

      const cutoff = nowMs - COOLDOWN_RETENTION_MS;
      const prune = (map: Record<string, number>): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const k of Object.keys(map)) {
          if (map[k] >= cutoff) out[k] = map[k];
        }
        return out;
      };

      const userLastReplyAt = prune(state.userLastReplyAt);
      for (const acct of repliedAccts) {
        userLastReplyAt[acct] = nowMs;
      }

      const userLastReactAt = prune(state.userLastReactAt);
      for (const acct of reactedAccts) {
        userLastReactAt[acct] = nowMs;
      }

      const userNoResponseUntil: Record<string, number> = {};
      for (const [acct, until] of Object.entries(state.userNoResponseUntil)) {
        if (until > nowMs) userNoResponseUntil[acct] = until;
      }

      const emojiSet = new Set(state.recentEmojis);
      for (const emoji of usedEmojis) {
        emojiSet.delete(emoji);
        emojiSet.add(emoji);
      }
      const nextEmojis = [...emojiSet].slice(-MAX_RECENT_EMOJIS);

      const next: WanderState = {
        ...state,
        lastPostAt: lastPostAt ?? state.lastPostAt,
        recent: mergedRecent,
        actedNoteIds: nextActed,
        userLastReplyAt,
        userLastReactAt,
        userNoResponseUntil,
        recentEmojis: nextEmojis,
      };
      return { next, result: next };
    });
  }
}
