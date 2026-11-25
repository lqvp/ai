import { describe, expect, it } from 'vitest';
import type { HourlyPoint } from '../src/modules/kiatsu/open-meteo.js';
import {
  type AlertOptions,
  type AlertState,
  backoffDelayMs,
  DEFAULT_ALERT_OPTIONS,
  deltaOverHours,
  evaluateAlert,
  formatDeltaHpa,
  formatLocalHourKey,
  indexOfLocalHour,
  shouldNotifySuspension,
} from '../src/modules/kiatsu/pressure-trend.js';

/** テスト用の1点。timeLocal は API と同じ `YYYY-MM-DDTHH:mm` 形式で渡す。 */
function point(timeLocal: string, pressureMsl: number | null): HourlyPoint {
  return { timeLocal, pressureMsl, temperatureC: 15, weatherCode: 3 };
}

/** 09:00〜12:00 の4点。気圧は 1013.2 → 1012.4 → 1010.9 → 1010.1 と下降。 */
const series: HourlyPoint[] = [
  point('2026-11-25T09:00', 1013.2),
  point('2026-11-25T10:00', 1012.4),
  point('2026-11-25T11:00', 1010.9),
  point('2026-11-25T12:00', 1010.1),
];

const options: AlertOptions = { thresholdHpa: -2, hysteresisHpa: 0.5 };
const calm: AlertState = { alerting: false };
const alerting: AlertState = { alerting: true };

describe('deltaOverHours', () => {
  it('returns the signed difference against k hours earlier', () => {
    // 12:00 と 09:00 の差。下がっているので負値になる
    expect(deltaOverHours(series, 3, 3)).toBeCloseTo(-3.1);
    expect(deltaOverHours(series, 2, 1)).toBeCloseTo(-1.5);
  });

  it('returns 0 (not null) when the pressure did not change', () => {
    const flat = [
      point('2026-11-25T09:00', 1010),
      point('2026-11-25T10:00', 1010),
    ];
    expect(deltaOverHours(flat, 1, 1)).toBe(0);
  });

  it('returns null when the earlier sample is missing', () => {
    const gap = [
      point('2026-11-25T09:00', null),
      point('2026-11-25T10:00', 1010),
    ];
    expect(deltaOverHours(gap, 1, 1)).toBeNull();
  });

  it('returns null when the target sample is missing', () => {
    const gap = [
      point('2026-11-25T09:00', 1010),
      point('2026-11-25T10:00', null),
    ];
    expect(deltaOverHours(gap, 1, 1)).toBeNull();
  });

  it('returns null when either index falls outside the series', () => {
    // 3時間前が系列の先頭より前になる
    expect(deltaOverHours(series, 2, 3)).toBeNull();
    expect(deltaOverHours(series, 0, 3)).toBeNull();
    // 対象の添字が範囲外
    expect(deltaOverHours(series, 4, 3)).toBeNull();
    expect(deltaOverHours(series, -1, 1)).toBeNull();
  });

  it('returns null for a k that cannot mean "k hours ago"', () => {
    expect(deltaOverHours(series, 3, 0)).toBeNull();
    expect(deltaOverHours(series, 3, -3)).toBeNull();
    expect(deltaOverHours(series, 3, 1.5)).toBeNull();
  });
});

describe('indexOfLocalHour', () => {
  it('finds the first sample with the matching hour', () => {
    expect(indexOfLocalHour(series, '2026-11-25T11:00')).toBe(2);
    expect(indexOfLocalHour(series, '2026-11-25T09:00')).toBe(0);
  });

  it('returns -1 when the hour is not in the series', () => {
    // 正時キーは分が :00 のものだけなので、:30 の文字列は一致しない
    expect(indexOfLocalHour(series, '2026-11-25T11:30')).toBe(-1);
    expect(indexOfLocalHour(series, '2026-11-26T11:00')).toBe(-1);
    expect(indexOfLocalHour([], '2026-11-25T11:00')).toBe(-1);
  });
});

describe('evaluateAlert', () => {
  it('keeps the state unchanged when delta is unknown', () => {
    expect(evaluateAlert(null, calm, options)).toEqual({
      state: { alerting: false },
      trigger: false,
    });
    // 警報中に欠測しても黙って解除しない
    expect(evaluateAlert(null, alerting, options)).toEqual({
      state: { alerting: true },
      trigger: false,
    });
  });

  it('triggers exactly at the threshold', () => {
    const result = evaluateAlert(options.thresholdHpa, calm, options);
    expect(result.trigger).toBe(true);
    expect(result.state.alerting).toBe(true);
  });

  it('does not trigger while staying above the threshold', () => {
    const result = evaluateAlert(-1.9, calm, options);
    expect(result.trigger).toBe(false);
    expect(result.state.alerting).toBe(false);
  });

  it('does not re-trigger inside the hysteresis band after a trigger', () => {
    const first = evaluateAlert(-2.0, calm, options);
    expect(first.trigger).toBe(true);

    // -1.8 は閾値より上だが、解除幅 (-2 + 0.5 = -1.5) は超えていない
    const result = evaluateAlert(-1.8, first.state, options);
    expect(result.trigger).toBe(false);
    expect(result.state.alerting).toBe(true);
  });

  it('keeps alerting exactly at threshold + hysteresis (release must be a clear exceedance)', () => {
    const result = evaluateAlert(-1.5, alerting, options);
    expect(result.trigger).toBe(false);
    expect(result.state.alerting).toBe(true);
  });

  it('releases above threshold + hysteresis, and can trigger again afterwards', () => {
    const released = evaluateAlert(-1.4, alerting, options);
    expect(released.state.alerting).toBe(false);
    expect(released.trigger).toBe(false);

    const again = evaluateAlert(-2.0, released.state, options);
    expect(again.trigger).toBe(true);
    expect(again.state.alerting).toBe(true);
  });

  it('does not mutate the state passed in', () => {
    const input: AlertState = { alerting: true };
    const result = evaluateAlert(-5, input, options);

    expect(input.alerting).toBe(true);
    expect(result.state).not.toBe(input);
    // 戻り値は新しいオブジェクトなので、書き換えても入力に影響しない
    result.state.alerting = false;
    expect(input.alerting).toBe(true);
  });

  it('exposes a sane default', () => {
    expect(DEFAULT_ALERT_OPTIONS).toEqual({
      thresholdHpa: -2,
      hysteresisHpa: 0.5,
    });
  });

  it('rejects invalid options instead of silently misjudging', () => {
    const invalid: AlertOptions[] = [
      { thresholdHpa: 0, hysteresisHpa: 0.5 },
      { thresholdHpa: 2, hysteresisHpa: 0.5 },
      { thresholdHpa: Number.NaN, hysteresisHpa: 0.5 },
      { thresholdHpa: Number.NEGATIVE_INFINITY, hysteresisHpa: 0.5 },
      { thresholdHpa: -2, hysteresisHpa: -0.1 },
      { thresholdHpa: -2, hysteresisHpa: Number.NaN },
      { thresholdHpa: -2, hysteresisHpa: Number.POSITIVE_INFINITY },
    ];

    for (const bad of invalid) {
      expect(() => evaluateAlert(-3, calm, bad)).toThrow(Error);
    }
    // 何が悪いのか分かるメッセージを出す
    expect(() =>
      evaluateAlert(-3, calm, { ...options, thresholdHpa: 1 })
    ).toThrow(/thresholdHpa/);
    expect(() =>
      evaluateAlert(-3, calm, { ...options, hysteresisHpa: -1 })
    ).toThrow(/hysteresisHpa/);
  });

  it('triggers only once while delta keeps falling monotonically', () => {
    let state: AlertState = { alerting: false };
    const triggers: number[] = [];

    // +1.0 hPa から -3.0 hPa まで 0.02 刻みで単調に下げる
    for (let step = 0; step <= 200; step++) {
      const delta = 1 - step * 0.02;
      const result = evaluateAlert(delta, state, options);
      if (result.trigger) triggers.push(delta);
      state = result.state;
    }

    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toBeLessThanOrEqual(options.thresholdHpa);
    expect(state.alerting).toBe(true);
  });

  it('does not chatter when delta oscillates around the threshold', () => {
    let state: AlertState = { alerting: false };
    let triggerCount = 0;

    // -2.01（警報）と -1.9（解除幅の内側）を交互に与える
    for (let i = 0; i < 20; i++) {
      const delta = i % 2 === 0 ? -2.01 : -1.9;
      const result = evaluateAlert(delta, state, options);
      if (result.trigger) triggerCount++;
      state = result.state;
    }

    expect(triggerCount).toBe(1);
    expect(state.alerting).toBe(true);
  });
});

describe('formatDeltaHpa', () => {
  it('rounds to one decimal with sign', () => {
    expect(formatDeltaHpa(-2.34)).toBe('-2.3');
    expect(formatDeltaHpa(1.25)).toBe('+1.3');
    expect(formatDeltaHpa(-2)).toBe('-2.0');
    expect(formatDeltaHpa(1)).toBe('+1.0');
  });

  it('omits the sign for zero, including negative zero after rounding', () => {
    expect(formatDeltaHpa(0)).toBe('0.0');
    expect(formatDeltaHpa(-0)).toBe('0.0');
    expect(formatDeltaHpa(-0.04)).toBe('0.0');
    expect(formatDeltaHpa(0.04)).toBe('0.0');
  });
});

describe('formatLocalHourKey', () => {
  it('formats in Asia/Tokyo by default', () => {
    // 10:30Z は JST 19:30。分は切り捨てて正時キーにする
    expect(formatLocalHourKey(new Date('2026-11-25T10:30:00Z'))).toBe(
      '2026-11-25T19:00'
    );
  });

  it('rolls over the date at the JST midnight', () => {
    // 15:30Z は JST 翌日 00:30
    expect(formatLocalHourKey(new Date('2026-11-25T15:30:00Z'))).toBe(
      '2026-11-26T00:00'
    );
  });

  it('zero-pads single-digit hours', () => {
    // 00:05Z は JST 09:05
    expect(formatLocalHourKey(new Date('2026-01-05T00:05:00Z'))).toBe(
      '2026-01-05T09:00'
    );
  });

  it('honours an explicit time zone instead of the process one', () => {
    const date = new Date('2026-11-25T10:30:00Z');
    expect(formatLocalHourKey(date, 'UTC')).toBe('2026-11-25T10:00');
    // 30分オフセットのタイムゾーンでも時だけを切り出す
    expect(formatLocalHourKey(date, 'Asia/Kolkata')).toBe('2026-11-25T16:00');
  });
});

describe('連続停止のバックオフと通知上限', () => {
  it('待機時間を指数的に伸ばし、上限で頭打ちにする', () => {
    // 1時間 → 2 → 4 → 8 → 16 → 16（上限）
    const hour = 60 * 60 * 1000;

    expect(backoffDelayMs(hour, 0)).toBe(hour);
    expect(backoffDelayMs(hour, 1)).toBe(2 * hour);
    expect(backoffDelayMs(hour, 2)).toBe(4 * hour);
    expect(backoffDelayMs(hour, 3)).toBe(8 * hour);
    expect(backoffDelayMs(hour, 4)).toBe(16 * hour);
    expect(backoffDelayMs(hour, 99)).toBe(16 * hour);
  });

  it('不正な入力は例外にする（設定ミスを黙って通さない）', () => {
    expect(() => backoffDelayMs(0, 0)).toThrow();
    expect(() => backoffDelayMs(Number.NaN, 0)).toThrow();
    expect(() => backoffDelayMs(-1, 0)).toThrow();
    // 停止回数が壊れていても、待機時間は壊さない
    expect(backoffDelayMs(1000, Number.NaN)).toBe(1000);
    expect(backoffDelayMs(1000, -3)).toBe(1000);
  });

  it('通知は上限回数までで打ち切る', () => {
    expect(shouldNotifySuspension(0, 2)).toBe(true);
    expect(shouldNotifySuspension(1, 2)).toBe(true);
    expect(shouldNotifySuspension(2, 2)).toBe(false);
    expect(shouldNotifySuspension(0, 0)).toBe(false);
    expect(() => shouldNotifySuspension(0, -1)).toThrow();
  });
});

describe('境界の浮動小数', () => {
  it('0.1 hPa 刻みの引き算の誤差で警報を落とさない', () => {
    // 1012.4 - 1010.1 は 2.2999999999999545 になり、素朴な比較では
    // しきい値 -2.3 を「下回っていない」と誤判定する。
    const hours = [
      {
        timeLocal: '2026-11-25T17:00',
        pressureMsl: 1012.4,
        temperatureC: null,
        weatherCode: null,
      },
      {
        timeLocal: '2026-11-25T18:00',
        pressureMsl: null,
        temperatureC: null,
        weatherCode: null,
      },
      {
        timeLocal: '2026-11-25T19:00',
        pressureMsl: null,
        temperatureC: null,
        weatherCode: null,
      },
      {
        timeLocal: '2026-11-25T20:00',
        pressureMsl: 1010.1,
        temperatureC: null,
        weatherCode: null,
      },
    ];

    const raw = hours[3].pressureMsl! - hours[0].pressureMsl!;
    expect(raw).toBeLessThan(2.3); // 誤差で 2.3 に届かないことを確認

    const delta = deltaOverHours(hours, 3, 3);
    expect(delta).not.toBeNull();
    expect(
      evaluateAlert(
        delta,
        { alerting: false },
        { thresholdHpa: -2.3, hysteresisHpa: 0.5 }
      ).trigger
    ).toBe(true);
  });
});
