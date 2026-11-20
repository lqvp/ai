import { describe, expect, it } from 'vitest';
import { toRainChance } from '../src/modules/weather/api.js';
import { formatWeatherToMfm } from '../src/modules/weather/format.js';
import type { WeatherForecast } from '../src/modules/weather/types.js';
import { WMO_CODE_MAP } from '../src/modules/weather/types.js';

const forecast: WeatherForecast = {
  date: '2026-11-20',
  dateLabel: '今日',
  weather: WMO_CODE_MAP[1],
  tempMax: 21,
  tempMin: 12,
  rain: {
    T00_06: 0,
    T06_12: 10,
    T12_18: 20,
    T18_24: 50,
  },
};

describe('toRainChance', () => {
  it('buckets each sample into the hour it covers', () => {
    // 時刻 T のサンプルは T-1〜T 時をカバーする:
    // 06:00 のサンプルは 5-6 時台（0-6時の区間）に属する
    const rain = toRainChance(
      {
        time: ['2026-11-20T05:00', '2026-11-20T06:00', '2026-11-20T07:00'],
        precipitation_probability: [10, 20, 30],
      },
      '2026-11-20'
    );
    expect(rain).toEqual({
      T00_06: 20,
      T06_12: 30,
      T12_18: null,
      T18_24: null,
    });
  });

  it('uses the maximum per bucket', () => {
    const rain = toRainChance(
      {
        time: ['2026-11-20T07:00', '2026-11-20T08:00', '2026-11-20T09:00'],
        precipitation_probability: [50, 70, 30],
      },
      '2026-11-20'
    );
    expect(rain?.T06_12).toBe(70);
  });

  it('attributes the next day 00:00 sample to the 18-24 bucket', () => {
    const rain = toRainChance(
      {
        time: ['2026-11-21T00:00'],
        precipitation_probability: [40],
      },
      '2026-11-20'
    );
    expect(rain?.T18_24).toBe(40);
    expect(rain?.T00_06).toBeNull();
  });

  it('skips null probabilities and other dates', () => {
    const rain = toRainChance(
      {
        time: [
          '2026-11-19T06:00', // 前日
          '2026-11-20T06:00',
          '2026-11-20T12:00',
          '2026-11-22T00:00', // 2日後
        ],
        precipitation_probability: [90, 10, null, 80],
      },
      '2026-11-20'
    );
    expect(rain).toEqual({
      T00_06: 10,
      T06_12: null,
      T12_18: null,
      T18_24: null,
    });
  });

  it('returns null when no data for the date', () => {
    expect(toRainChance(undefined, '2026-11-20')).toBeNull();
    expect(
      toRainChance(
        { time: ['2026-11-21T06:00'], precipitation_probability: [10] },
        '2026-11-20'
      )
    ).toBeNull();
  });
});

describe('weather format', () => {
  it('formats weather into MFM', () => {
    const text = formatWeatherToMfm('東京都 千代田区', forecast, 'おはよう');
    expect(text).toContain('東京都 千代田区の今日の天気');
    expect(text).toContain('$[fg.color=ff4500 21℃]');
    expect(text).toContain('$[fg.color=4169e1 12℃]');
    expect(text).toContain('12-18時');
    expect(text).toContain('おはよう');
  });

  it('omits rain section when absent and shows noTemp for missing temperatures', () => {
    const noData: WeatherForecast = {
      ...forecast,
      tempMax: null,
      tempMin: null,
      rain: null,
    };
    const text = formatWeatherToMfm('東京都', noData, '');
    expect(text).not.toContain('降水確率');
    expect(text).not.toContain('最高:');
    expect(text).toContain('気温データがありません');
  });

  it('renders missing rain buckets as placeholder', () => {
    const partial: WeatherForecast = {
      ...forecast,
      rain: { T00_06: 10, T06_12: null, T12_18: null, T18_24: null },
    };
    const text = formatWeatherToMfm('東京都', partial, '');
    expect(text).toContain('10%');
    expect(text).toContain('-');
  });

  it('selects emoji by WMO weather code', () => {
    expect(WMO_CODE_MAP[0].emoji).toBe('☀️');
    expect(WMO_CODE_MAP[95].description).toBe('雷雨');
  });
});
