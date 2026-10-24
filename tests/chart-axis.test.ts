import { describe, expect, it } from 'vitest';
import { calcChartStepSize } from '../src/modules/chart/render-chart.js';

/** 旧実装 (parseInt を数値に適用していたもの) の再現。回帰比較用。 */
function legacyStepSize(range: number, tiks: number): number {
  const tempStep = range / tiks;
  const mag = Math.floor(Math.log10(tempStep));
  const magPow = Math.pow(10, mag);
  const magMsd = parseInt(String(tempStep / magPow));
  return magMsd * magPow;
}

describe('calcChartStepSize', () => {
  it('matches the legacy parseInt-based result across realistic ranges', () => {
    // チャートのY軸で実際に出る範囲 (正のrange、tiksは2〜11)
    const cases: [number, number][] = [];
    for (const range of [1, 3, 7, 12, 42, 95, 240, 999, 1234, 98765]) {
      for (let tiks = 2; tiks <= 11; tiks++) {
        cases.push([range, tiks]);
      }
    }
    for (const [range, tiks] of cases) {
      expect(calcChartStepSize(range, tiks)).toBe(legacyStepSize(range, tiks));
    }
  });

  it('returns pretty steps', () => {
    // range/tiks = 9.5 → msd 9 → step 9
    expect(calcChartStepSize(95, 10)).toBe(9);
    // range/tiks = 0.42 → mag=-1, msd 4 → step 0.4
    expect(calcChartStepSize(4.2, 10)).toBeCloseTo(0.4);
  });

  it('does not break on huge magnitudes where parseInt would', () => {
    // parseInt は 1e21 を文字列化すると "1e+21" となり 1 を返すが、
    // Math.trunc ベースは数値として正しく扱う。
    const step = calcChartStepSize(1e22, 10);
    expect(step).toBe(1e21);
  });
});
