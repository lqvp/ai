import { describe, expect, it } from 'vitest';
import {
  formatWeatherToMfm,
  weatherEmoji,
} from '../src/modules/weather/format.js';
import type { WeatherInfo } from '../src/modules/weather/types.js';

const info: WeatherInfo = {
  place: '東京都 千代田区',
  dateLabel: '今日',
  telop: '晴れ',
  tempMin: '12',
  tempMax: '21',
  rain: {
    T00_06: '0%',
    T06_12: '10%',
    T12_18: '20%',
    T18_24: '50%',
  },
  greeting: 'おはよう',
};

describe('weather format', () => {
  it('selects emoji by telop', () => {
    expect(weatherEmoji('晴れ')).toBe('☀️');
    expect(weatherEmoji('雷')).toBe('⚡');
    expect(weatherEmoji('不明')).toBe('🌈');
  });

  it('formats weather into MFM', () => {
    const text = formatWeatherToMfm(info);
    expect(text).toContain('東京都 千代田区の今日の天気');
    expect(text).toContain('$[fg.color=ff4500 21]');
    expect(text).toContain('$[fg.color=4169e1 12]');
    expect(text).toContain('12-18時');
    expect(text).toContain('おはよう');
  });

  it('omits temperature and rain sections when absent', () => {
    const text = formatWeatherToMfm({
      ...info,
      tempMin: null,
      tempMax: null,
      rain: null,
      greeting: undefined,
    });
    expect(text).not.toContain('気温');
    expect(text).not.toContain('降水確率');
  });

  it('includes additional message when present', () => {
    const text = formatWeatherToMfm({
      ...info,
      additionalMessage: '気温データなし',
    });
    expect(text).toContain('気温データなし');
  });
});
