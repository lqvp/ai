import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initConfig, resolveConfig } from '../src/config/index.js';
import { isBlockedAichatUser } from '../src/modules/aichat/engagement.js';
import { LlmUsageGuard } from '../src/modules/aichat/llm-usage-guard.js';

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-llm-usage-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('engagement blocklist', () => {
  it('matches blocked users by id or normalized acct', () => {
    initConfig(
      resolveConfig({
        host: 'https://example.com',
        i: 'token',
        aichat: {
          engagement: {
            blockedUsers: ['u-blocked', '@bad@remote.example'],
          },
        },
      })
    );

    expect(
      isBlockedAichatUser({ id: 'u-blocked', username: 'someone', host: null })
    ).toBe(true);
    expect(
      isBlockedAichatUser({
        id: 'other-id',
        username: 'bad',
        host: 'remote.example',
      })
    ).toBe(true);
    expect(
      isBlockedAichatUser({ id: 'u-ok', username: 'good', host: null })
    ).toBe(false);
  });
});

describe('LlmUsageGuard', () => {
  it('persists the daily call budget across restart', async () => {
    const dir = createTempDir();
    initConfig(
      resolveConfig({
        host: 'https://example.com',
        i: 'token',
        aichat: { llmBudget: { maxCallsPerDay: 1 } },
      })
    );
    const filePath = join(dir, 'aichat-llm-usage.json');
    const nowMs = Date.parse('2026-11-24T12:00:00Z');

    const first = new LlmUsageGuard({ filePath, now: () => nowMs });
    expect(await first.tryAcquire()).toEqual({ allowed: true });

    const restarted = new LlmUsageGuard({ filePath, now: () => nowMs });
    expect(await restarted.tryAcquire()).toEqual({
      allowed: false,
      reason: 'daily_limit',
    });
  });

  it('backs off after consecutive LLM failures and resets on success', async () => {
    const dir = createTempDir();
    initConfig(
      resolveConfig({
        host: 'https://example.com',
        i: 'token',
        aichat: {
          llmBudget: {
            maxCallsPerDay: 10,
            maxConsecutiveErrors: 2,
            errorBackoffMinutes: 10,
          },
        },
      })
    );
    let nowMs = Date.parse('2026-11-24T12:00:00Z');
    const guard = new LlmUsageGuard({
      filePath: join(dir, 'aichat-llm-usage.json'),
      now: () => nowMs,
    });

    expect(await guard.tryAcquire()).toEqual({ allowed: true });
    await guard.recordOutcome(false);
    expect(await guard.tryAcquire()).toEqual({ allowed: true });
    await guard.recordOutcome(false);
    expect(await guard.tryAcquire()).toEqual({
      allowed: false,
      reason: 'error_backoff',
    });

    nowMs += 11 * 60_000;
    expect(await guard.tryAcquire()).toEqual({ allowed: true });
    await guard.recordOutcome(true);
    expect(await guard.tryAcquire()).toEqual({ allowed: true });
  });
  it('backs off structured JSON failures without blocking normal chat calls', async () => {
    const dir = createTempDir();
    initConfig(
      resolveConfig({
        host: 'https://example.com',
        i: 'token',
        aichat: {
          llmBudget: {
            maxCallsPerDay: 10,
            maxConsecutiveErrors: 2,
            errorBackoffMinutes: 10,
          },
        },
      })
    );
    const guard = new LlmUsageGuard({
      filePath: join(dir, 'aichat-llm-usage.json'),
      now: () => Date.parse('2026-11-24T12:00:00Z'),
    });

    expect(await guard.tryAcquire('structured')).toEqual({ allowed: true });
    await guard.recordOutcome(false, 'structured');
    expect(await guard.tryAcquire('structured')).toEqual({ allowed: true });
    await guard.recordOutcome(false, 'structured');

    expect(await guard.tryAcquire('structured')).toEqual({
      allowed: false,
      reason: 'error_backoff',
    });
    expect(await guard.tryAcquire('general')).toEqual({ allowed: true });
  });
});
