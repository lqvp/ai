import type serifs from '@/serifs.js';

export type AutoNoteSerifKey = keyof (typeof serifs)['weather']['autoNote'];

export interface WmoCodeInfo {
  emoji: string;
  description: string;
  serifKey: AutoNoteSerifKey;
}

/**
 * Open-Meteo が返す WMO weather interpretation codes (WW)。
 * https://open-meteo.com/en/docs
 */
export const WMO_CODE_MAP: Record<number, WmoCodeInfo> = {
  0: { emoji: '☀️', description: '快晴', serifKey: 'sunny' },
  1: { emoji: '🌤️', description: '晴れ', serifKey: 'sunny' },
  2: { emoji: '⛅', description: '一部曇り', serifKey: 'cloudy' },
  3: { emoji: '☁️', description: '曇り', serifKey: 'cloudy' },
  45: { emoji: '🌫️', description: '霧', serifKey: 'cloudy' },
  48: { emoji: '🌫️', description: '霧氷', serifKey: 'cloudy' },
  51: { emoji: '🌦️', description: '軽い霧雨', serifKey: 'rainy' },
  53: { emoji: '🌦️', description: '霧雨', serifKey: 'rainy' },
  55: { emoji: '🌧️', description: '激しい霧雨', serifKey: 'rainy' },
  56: { emoji: '🌨️', description: '軽い着氷性の霧雨', serifKey: 'snowy' },
  57: { emoji: '🌨️', description: '着氷性の霧雨', serifKey: 'snowy' },
  61: { emoji: '☔', description: '小雨', serifKey: 'rainy' },
  63: { emoji: '☔', description: '雨', serifKey: 'rainy' },
  65: { emoji: '☔', description: '激しい雨', serifKey: 'rainy' },
  66: { emoji: '🌨️', description: '軽い着氷性の雨', serifKey: 'snowy' },
  67: { emoji: '🌨️', description: '着氷性の雨', serifKey: 'snowy' },
  71: { emoji: '☃️', description: '小雪', serifKey: 'snowy' },
  73: { emoji: '☃️', description: '雪', serifKey: 'snowy' },
  75: { emoji: '☃️', description: '大雪', serifKey: 'snowy' },
  77: { emoji: '❄️', description: '霧雪', serifKey: 'snowy' },
  80: { emoji: '☔', description: 'にわか雨', serifKey: 'rainy' },
  81: { emoji: '☔', description: '激しいにわか雨', serifKey: 'rainy' },
  82: { emoji: '☔', description: '猛烈なにわか雨', serifKey: 'rainy' },
  85: { emoji: '❄️', description: 'にわか雪', serifKey: 'snowy' },
  86: { emoji: '❄️', description: '激しいにわか雪', serifKey: 'snowy' },
  95: { emoji: '⚡', description: '雷雨', serifKey: 'thunder' },
  96: { emoji: '⛈️', description: '雷雨（雹）', serifKey: 'thunder' },
  99: { emoji: '⛈️', description: '激しい雷雨（雹）', serifKey: 'thunder' },
};

export const UNKNOWN_WMO_CODE: WmoCodeInfo = {
  emoji: '❓',
  description: '不明',
  serifKey: 'other',
};

/** 6時間ごとの降水確率（%）。キーは時刻帯。データがない区間は null。 */
export interface RainChance {
  T00_06: number | null;
  T06_12: number | null;
  T12_18: number | null;
  T18_24: number | null;
}

export interface WeatherForecast {
  date: string;
  /** 今日 / 明日 / 明後日 のような相対日付ラベル。 */
  dateLabel: string;
  weather: WmoCodeInfo;
  tempMax: number | null;
  tempMin: number | null;
  rain: RainChance | null;
}

export interface GeocodingResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}
