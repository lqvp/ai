import { describe, expect, it } from 'vitest';
import { formatWeatherToMfm } from '../src/modules/weather/format.js';
import type {
  WeatherForecast,
  WeatherInfo,
} from '../src/modules/weather/types.js';
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

const info: WeatherInfo = {
  place: '東京都 千代田区',
  forecasts: [forecast],
};

describe('weather format', () => {
  it('formats weather into MFM', () => {
    const text = formatWeatherToMfm(info, forecast, 'おはよう');
    expect(text).toContain('東京都 千代田区の今日の天気');
    expect(text).toContain('$[fg.color=ff4500 21℃]');
    expect(text).toContain('$[fg.color=4169e1 12℃]');
    expect(text).toContain('12-18時');
    expect(text).toContain('おはよう');
  });

  it('omits temperature and rain sections when absent', () => {
    const noData: WeatherForecast = {
      ...forecast,
      tempMax: null,
      tempMin: null,
      rain: null,
    };
    const text = formatWeatherToMfm(
      { ...info, forecasts: [noData] },
      noData,
      ''
    );
    expect(text).not.toContain('気温');
    expect(text).not.toContain('降水確率');
    expect(text).not.toContain('おはよう');
  });

  it('selects emoji by WMO weather code', () => {
    expect(WMO_CODE_MAP[0].emoji).toBe('☀️');
    expect(WMO_CODE_MAP[95].description).toBe('雷雨');
  });
});
