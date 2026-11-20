import { describe, expect, it } from 'vitest';
import {
  appendTriggers,
  clampEnergy,
  createDefaultMoodState,
  decayMood,
  HALF_LIFE_MS,
  MAX_TRIGGERS,
  moodLevelOf,
} from '../src/modules/aichat/mood-state.js';

const HOUR = 60 * 60 * 1000;

describe('decayMood', () => {
  it('returns the same state when no time has elapsed', () => {
    const state = createDefaultMoodState(1000);
    expect(decayMood(state, 1000)).toEqual(state);
  });

  it('decays energy toward baseline with 24h half-life', () => {
    const state = { ...createDefaultMoodState(0), energy: 100 };
    const after24h = decayMood(state, 24 * HOUR);
    // 24時間後は baseline(60) との差が半分になる
    expect(after24h.energy).toBe(80);
  });

  it('decays energy upward when below baseline', () => {
    const state = { ...createDefaultMoodState(0), energy: 20 };
    const after24h = decayMood(state, 24 * HOUR);
    expect(after24h.energy).toBe(40);
  });

  it('shifts mood at most one step toward calm per update', () => {
    const state = { ...createDefaultMoodState(0), mood: 'excited' as const };
    const after48h = decayMood(state, 48 * HOUR);
    // excited → happy への1ステップのみ（calm へ一気には戻らない）
    expect(after48h.mood).toBe('happy');
  });

  it('shifts sad mood at most one step up toward calm', () => {
    const state = { ...createDefaultMoodState(0), mood: 'sad' as const };
    const after48h = decayMood(state, 48 * HOUR);
    expect(after48h.mood).toBe('tired');
  });

  it('keeps calm state unchanged in mood after long elapsed time', () => {
    const state = { ...createDefaultMoodState(0), energy: 90 };
    const afterLong = decayMood(state, 30 * 24 * HOUR);
    expect(afterLong.mood).toBe('calm');
    // 長期間経過でエネルギーはbaselineにほぼ収束する
    expect(afterLong.energy).toBeLessThanOrEqual(61);
  });

  it('treats invalid mood as calm level', () => {
    expect(moodLevelOf('unknown')).toBe(moodLevelOf('calm'));
  });
});

describe('appendTriggers', () => {
  it('keeps only the most recent MAX_TRIGGERS entries', () => {
    const triggers = Array.from({ length: MAX_TRIGGERS }, (_, i) => `t${i}`);
    const result = appendTriggers(triggers, ['new']);
    expect(result).toHaveLength(MAX_TRIGGERS);
    expect(result[result.length - 1]).toBe('new');
    expect(result[0]).toBe('t1');
  });
});

describe('clampEnergy', () => {
  it('clamps to 0-100 and rounds', () => {
    expect(clampEnergy(-5)).toBe(0);
    expect(clampEnergy(150)).toBe(100);
    expect(clampEnergy(60.4)).toBe(60);
  });
});

describe('HALF_LIFE_MS', () => {
  it('is 24 hours', () => {
    expect(HALF_LIFE_MS).toBe(24 * HOUR);
  });
});
