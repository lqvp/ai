import { describe, expect, it } from 'vitest';
import {
  daysLeftInYear,
  formatJapaneseDate,
  isLeapYear,
  monthDayKey,
  msUntilNextHour,
  nowHour,
  todayKey,
} from '../src/services/clock.js';

describe('clock', () => {
  it('treats dates as Asia/Tokyo regardless of the process timezone', () => {
    // 2026-01-01T15:30:00Z は JST では 2026-01-02 00:30
    const date = new Date('2026-01-01T15:30:00Z');
    expect(todayKey(date)).toBe('2026-01-02');
    expect(monthDayKey(date)).toBe('01-02');
    expect(nowHour(date)).toBe(0);
    expect(formatJapaneseDate(date)).toBe('2026年 1月 2日 (金)');
  });

  it('computes the remaining days of the year including today', () => {
    expect(daysLeftInYear(new Date('2026-01-01T03:00:00Z'))).toBe(365);
    expect(daysLeftInYear(new Date('2026-12-31T03:00:00Z'))).toBe(1);
    expect(daysLeftInYear(new Date('2024-12-31T03:00:00Z'))).toBe(1);
  });

  it('detects leap years', () => {
    expect(isLeapYear(2024)).toBe(true);
    expect(isLeapYear(2026)).toBe(false);
    expect(isLeapYear(2000)).toBe(true);
    expect(isLeapYear(1900)).toBe(false);
  });

  it('returns a positive delay to the next target hour', () => {
    const delay = msUntilNextHour(0, new Date('2026-01-01T03:00:00Z'));
    expect(delay).toBeGreaterThan(0);
    expect(delay).toBeLessThanOrEqual(24 * 60 * 60 * 1000);
  });
});
