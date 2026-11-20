import axios from 'axios';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import Module from '@/module.js';
import * as mfm from '@/utils/mfm.js';
import config from '../../config.js';
import serifs from '../../serifs.js';

const OPEN_METEO_API = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODING_API =
  'https://geocoding-api.open-meteo.com/v1/search';

const REQUEST_TIMEOUT_MS = 10000;
const FORECAST_DAYS = 3;
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

const DEFAULT_WEATHER_PLACE = config.weatherAutoNotePref ?? '東京';
const DEFAULT_AUTO_NOTE_HOUR = config.weatherAutoNoteHour ?? 7;

type AutoNoteSerifKey = keyof typeof serifs.weather.autoNote;

interface WmoCodeInfo {
  emoji: string;
  description: string;
  serifKey: AutoNoteSerifKey;
}

// WMO weather interpretation codes (WW) defined by Open-Meteo.
// https://open-meteo.com/en/docs
const WMO_CODE_MAP: Record<number, WmoCodeInfo> = {
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

const UNKNOWN_WMO_CODE: WmoCodeInfo = {
  emoji: '❓',
  description: '不明',
  serifKey: 'other',
};

interface GeocodingResult {
  id: number;
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  admin1?: string;
}

interface OpenMeteoForecastResponse {
  daily?: {
    time: string[];
    weathercode: number[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
  };
}

interface WeatherForecast {
  date: string;
  dateLabel: string;
  weather: WmoCodeInfo;
  tempMax: number | null;
  tempMin: number | null;
}

interface WeatherInfo {
  place: string;
  forecasts: WeatherForecast[];
}

const DATE_LABELS = ['今日', '明日', '明後日'] as const;

function toForecasts(data: OpenMeteoForecastResponse): WeatherForecast[] {
  const daily = data.daily;
  if (!daily) return [];

  return daily.time.map((date, index) => ({
    date,
    // Open-Meteo returns daily data starting from today in the
    // location's timezone, so the array index maps to the relative day.
    dateLabel: DATE_LABELS[index] ?? `${index}日後`,
    weather: WMO_CODE_MAP[daily.weathercode[index]] ?? UNKNOWN_WMO_CODE,
    tempMax: daily.temperature_2m_max[index] ?? null,
    tempMin: daily.temperature_2m_min[index] ?? null,
  }));
}

function normalizeDateLabel(dayInput?: string): string {
  if (!dayInput) return '今日';
  if (['明日', 'あした'].includes(dayInput)) return '明日';
  if (['明後日', 'あさって'].includes(dayInput)) return '明後日';
  return '今日';
}

export default class WeatherModule extends Module {
  public readonly name = 'weather';

  @bindThis
  public install() {
    this.scheduleWeatherAutoNote();
    return {
      mentionHook: this.mentionHook,
    };
  }

  private async searchLocation(query: string): Promise<GeocodingResult | null> {
    try {
      const response = await axios.get<{ results?: GeocodingResult[] }>(
        OPEN_METEO_GEOCODING_API,
        {
          params: {
            name: query,
            count: 1,
            language: 'ja',
            format: 'json',
          },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );
      return response.data.results?.[0] ?? null;
    } catch (e) {
      this.log(`Error searching location ${query}: ${e}`);
      return null;
    }
  }

  private async fetchForecast(
    lat: number,
    lon: number
  ): Promise<WeatherForecast[]> {
    try {
      const response = await axios.get<OpenMeteoForecastResponse>(
        OPEN_METEO_API,
        {
          params: {
            latitude: lat,
            longitude: lon,
            daily: 'weathercode,temperature_2m_max,temperature_2m_min',
            timezone: 'auto',
            forecast_days: FORECAST_DAYS,
          },
          timeout: REQUEST_TIMEOUT_MS,
        }
      );
      return toForecasts(response.data);
    } catch (e) {
      this.log(`Error fetching forecast for ${lat},${lon}: ${e}`);
      return [];
    }
  }

  private formatTempBlock(forecast: WeatherForecast): string {
    if (forecast.tempMax === null && forecast.tempMin === null) {
      return serifs.weather.noTemp;
    }
    const max =
      forecast.tempMax !== null ? `${Math.round(forecast.tempMax)}℃` : '?';
    const min =
      forecast.tempMin !== null ? `${Math.round(forecast.tempMin)}℃` : '?';
    return `🌡️ ${mfm.bold('気温')}\n最高: ${mfm.color(max, 'ff4500')}\n最低: ${mfm.color(min, '4169e1')}`;
  }

  private formatWeatherToMfm(
    info: WeatherInfo,
    forecast: WeatherForecast,
    greeting: string
  ): string {
    return `<center>
${mfm.bold(`${info.place}の${forecast.dateLabel}の天気`)} ${forecast.weather.emoji}
---
${forecast.dateLabel}の天気は「${mfm.bold(forecast.weather.description)}」みたいですよ！

${this.formatTempBlock(forecast)}
---
</center>
${greeting}
`;
  }

  private scheduleWeatherAutoNote() {
    const now = new Date();
    const nextRunTime = new Date(now);
    nextRunTime.setHours(DEFAULT_AUTO_NOTE_HOUR, 0, 0, 0);
    if (now >= nextRunTime) {
      nextRunTime.setDate(nextRunTime.getDate() + 1);
    }

    setTimeout(() => {
      this.postWeatherNoteForAuto();
      setInterval(this.postWeatherNoteForAuto, DAILY_INTERVAL_MS);
    }, nextRunTime.getTime() - now.getTime());
  }

  @bindThis
  private async postWeatherNoteForAuto() {
    try {
      const location = await this.searchLocation(DEFAULT_WEATHER_PLACE);
      if (!location) {
        this.log(`Location not found for auto-note: ${DEFAULT_WEATHER_PLACE}`);
        return;
      }

      const forecasts = await this.fetchForecast(
        location.latitude,
        location.longitude
      );
      if (forecasts.length === 0) {
        this.log(`No forecast data for auto-note: ${DEFAULT_WEATHER_PLACE}`);
        return;
      }

      const today = forecasts[0];
      const text = this.formatWeatherToMfm(
        { place: location.name, forecasts },
        today,
        serifs.weather.autoNote[today.weather.serifKey]
      );
      this.ai.api('notes/create', { text });
    } catch (e) {
      this.log(`Error in postWeatherNoteForAuto: ${e}`);
    }
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.text) return false;

    const match = msg.text.match(
      /(?:天気予報|天気|てんき)[\s　]*(今日|明日|明後日|あした|あさって)?[\s　]*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-zA-Z0-9]+)?/u
    );
    if (!match) return false;

    const place = match[2]?.trim() || DEFAULT_WEATHER_PLACE;
    const dateLabel = normalizeDateLabel(match[1]?.trim());

    const location = await this.searchLocation(place);
    if (!location) {
      msg.reply(serifs.weather.notFound(place));
      return { reaction: '❌' };
    }

    const forecasts = await this.fetchForecast(
      location.latitude,
      location.longitude
    );
    const forecast = forecasts.find((f) => f.dateLabel === dateLabel);
    if (forecasts.length === 0 || !forecast) {
      msg.reply(serifs.weather.fetchError);
      return { reaction: '❌' };
    }

    msg.reply(
      this.formatWeatherToMfm({ place: location.name, forecasts }, forecast, '')
    );
    return { reaction: forecast.weather.emoji };
  }
}
