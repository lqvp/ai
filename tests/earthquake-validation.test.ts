import { describe, expect, it, vi } from 'vitest';
import type { WolfxEarthquakeData } from '../src/modules/earthquake_warning/types.js';
import {
  shouldReportEarthquake,
  validateEarthquakeData,
  validateTsunamiData,
} from '../src/modules/earthquake_warning/validation.js';

const earthquake = (
  overrides: Partial<WolfxEarthquakeData> = {}
): WolfxEarthquakeData =>
  ({
    type: 'earthquake',
    EventID: '20261022',
    AnnouncedTime: '2026/10/22 12:00:00',
    Hypocenter: '茨城県南部',
    Latitude: 36.0,
    Longitude: 140.0,
    Magunitude: 5.0,
    Depth: 50,
    MaxIntensity: '4',
    ...overrides,
  }) as WolfxEarthquakeData;

describe('validateEarthquakeData', () => {
  it('accepts a complete payload', () => {
    expect(validateEarthquakeData(earthquake())).toBe(true);
  });

  it('rejects missing fields and wrong types', () => {
    const log = vi.fn();
    expect(validateEarthquakeData({}, log)).toBe(false);
    expect(log).toHaveBeenCalled();

    expect(validateEarthquakeData(earthquake({ MaxIntensity: 4 as any }))).toBe(
      false
    );
    expect(validateEarthquakeData(earthquake({ Latitude: 'abc' as any }))).toBe(
      false
    );
  });
});

describe('validateTsunamiData', () => {
  it('accepts the expected shape and rejects others', () => {
    const valid = {
      id: 't1',
      code: 552,
      time: '2026/10/22 12:00:00',
      cancelled: false,
      issue: { time: '2026/10/22 12:00:00', type: '津波注意報' },
      areas: [],
    };
    expect(validateTsunamiData(valid)).toBe(true);
    expect(validateTsunamiData({ ...valid, code: 551 })).toBe(false);
    expect(validateTsunamiData({ ...valid, issue: null })).toBe(false);
    expect(validateTsunamiData(null)).toBe(false);
  });
});

describe('shouldReportEarthquake', () => {
  const threshold = { minIntensity: 3, minMagnitudeForWeak: 4.5 };

  it('ignores quakes below the intensity threshold', () => {
    expect(
      shouldReportEarthquake(earthquake({ MaxIntensity: '2' }), threshold)
    ).toBe(false);
  });

  it('requires a magnitude for weak (under 4) quakes', () => {
    expect(
      shouldReportEarthquake(
        earthquake({ MaxIntensity: '3', Magunitude: 4.0 }),
        threshold
      )
    ).toBe(false);
    expect(
      shouldReportEarthquake(
        earthquake({ MaxIntensity: '3', Magunitude: 5.0 }),
        threshold
      )
    ).toBe(true);
  });

  it('reports intensity 4+ regardless of magnitude', () => {
    expect(
      shouldReportEarthquake(
        earthquake({ MaxIntensity: '4', Magunitude: 3.0 }),
        threshold
      )
    ).toBe(true);
  });
});
