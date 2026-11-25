import path from 'node:path';
import config from '@/config/index.js';
import { todayKey } from '@/services/clock.js';
import { JsonFileStore, stripDangerousKeys } from './json-file-store.js';

export type LlmUsageState = {
  version: 1;
  day: string;
  calls: number;
  consecutiveErrors: number;
  backoffUntil: number;
};

export type LlmBudgetDecision =
  | { allowed: true }
  | { allowed: false; reason: 'daily_limit' | 'error_backoff' };

function normalizeUsageState(raw: unknown): LlmUsageState {
  const safe = stripDangerousKeys(raw);
  const obj =
    safe != null && typeof safe === 'object'
      ? (safe as Record<string, unknown>)
      : {};
  return {
    version: 1,
    day: typeof obj.day === 'string' ? obj.day : '',
    calls:
      typeof obj.calls === 'number' && Number.isFinite(obj.calls)
        ? Math.max(0, Math.trunc(obj.calls))
        : 0,
    consecutiveErrors:
      typeof obj.consecutiveErrors === 'number' &&
      Number.isFinite(obj.consecutiveErrors)
        ? Math.max(0, Math.trunc(obj.consecutiveErrors))
        : 0,
    backoffUntil:
      typeof obj.backoffUntil === 'number' && Number.isFinite(obj.backoffUntil)
        ? obj.backoffUntil
        : 0,
  };
}

function createDefaultUsageState(): LlmUsageState {
  return {
    version: 1,
    day: todayKey(),
    calls: 0,
    consecutiveErrors: 0,
    backoffUntil: 0,
  };
}

function rollover(state: LlmUsageState, day: string): LlmUsageState {
  if (state.day === day) return state;
  return {
    ...state,
    day,
    calls: 0,
  };
}

/**
 * aichat が発行する LLM 呼び出し全体の日次予算と連続エラーバックオフ。
 * プロセス再起動後も `aichat-llm-usage.json` で保持する。
 */
export class LlmUsageGuard {
  private readonly store: JsonFileStore<LlmUsageState>;
  private readonly now: () => number;

  constructor(options: {
    filePath: string;
    log?: (message: string) => void;
    now?: () => number;
  }) {
    this.now = options.now ?? (() => Date.now());
    this.store = new JsonFileStore<LlmUsageState>({
      filePath: options.filePath,
      createDefault: createDefaultUsageState,
      normalize: normalizeUsageState,
      log: options.log,
      now: this.now,
    });
  }

  public async tryAcquire(): Promise<LlmBudgetDecision> {
    const budget = config.aichat?.llmBudget;
    if (budget?.enabled === false) return { allowed: true };

    const maxCalls = budget?.maxCallsPerDay ?? 1000;
    const nowMs = this.now();
    const day = todayKey(new Date(nowMs));

    return this.store.update<LlmBudgetDecision>((state) => {
      const current = rollover(state, day);
      if (current.backoffUntil > nowMs) {
        return {
          next: current,
          result: { allowed: false, reason: 'error_backoff' },
        };
      }
      if (current.calls >= maxCalls) {
        return {
          next: current,
          result: { allowed: false, reason: 'daily_limit' },
        };
      }
      const next = { ...current, calls: current.calls + 1 };
      return { next, result: { allowed: true } };
    });
  }

  public async recordOutcome(success: boolean): Promise<void> {
    const budget = config.aichat?.llmBudget;
    if (budget?.enabled === false) return;

    const maxErrors = budget?.maxConsecutiveErrors ?? 5;
    const backoffMs = (budget?.errorBackoffMinutes ?? 10) * 60_000;
    const nowMs = this.now();
    const day = todayKey(new Date(nowMs));

    await this.store.update((state) => {
      const current = rollover(state, day);
      const consecutiveErrors = success ? 0 : current.consecutiveErrors + 1;
      const backoffUntil =
        !success && consecutiveErrors >= maxErrors
          ? nowMs + backoffMs
          : current.backoffUntil;
      return {
        next: { ...current, consecutiveErrors, backoffUntil },
        result: undefined,
      };
    });
  }
}

const sharedGuards = new Map<string, LlmUsageGuard>();

export function getLlmUsageGuard(
  log?: (message: string) => void
): LlmUsageGuard {
  const memoryDir = path.resolve(config.memoryDir || '.');
  const filePath = path.join(memoryDir, 'aichat-llm-usage.json');
  let guard = sharedGuards.get(filePath);
  if (guard == null) {
    guard = new LlmUsageGuard({ filePath, log });
    sharedGuards.set(filePath, guard);
  }
  return guard;
}

/** テスト用に共有ガードのインスタンスを破棄する。 */
export function resetLlmUsageGuardForTest(): void {
  sharedGuards.clear();
}
