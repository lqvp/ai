import { getJson } from '@/http/client.js';
import type { GeocodingResult, RainChance, WeatherForecast } from './types.js';
import { UNKNOWN_WMO_CODE, WMO_CODE_MAP } from './types.js';

const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODING_URL =
  'https://geocoding-api.open-meteo.com/v1/search';

const REQUEST_TIMEOUT_MS = 10_000;
const FORECAST_DAYS = 3;

const DATE_LABELS = ['今日', '明日', '明後日'] as const;

/** Open-Meteo の予報 API レスポンス（利用するフィールドのみ）。 */
interface ForecastResponse {
  daily?: {
    time: string[];
    weathercode: number[];
    temperature_2m_max: (number | null)[];
    temperature_2m_min: (number | null)[];
  };
  hourly?: {
    time: string[];
    precipitation_probability: (number | null)[];
  };
}

/**
 * Open-Meteo API との通信と地名解決。
 */
export class WeatherApi {
  constructor(private readonly log: (message: string) => void) {}

  /**
   * 地名を検索して座標を解決する。
   *
   * @returns 見つからない場合、または取得に失敗した場合に null
   */
  public async searchLocation(query: string): Promise<GeocodingResult | null> {
    try {
      const data = await getJson<{ results?: GeocodingResult[] }>(
        OPEN_METEO_GEOCODING_URL,
        {
          searchParams: {
            name: query,
            count: '1',
            language: 'ja',
            format: 'json',
          },
          timeoutMs: REQUEST_TIMEOUT_MS,
        }
      );
      return data.results?.[0] ?? null;
    } catch (e) {
      this.log(`Error searching location ${query}: ${String(e)}`);
      return null;
    }
  }

  /**
   * 座標から日単位の予報を取得する。
   *
   * @returns 取得に失敗した場合に空配列
   */
  public async fetchDailyForecasts(
    latitude: number,
    longitude: number
  ): Promise<WeatherForecast[]> {
    try {
      const data = await getJson<ForecastResponse>(OPEN_METEO_FORECAST_URL, {
        searchParams: {
          latitude: String(latitude),
          longitude: String(longitude),
          daily: 'weathercode,temperature_2m_max,temperature_2m_min',
          hourly: 'precipitation_probability',
          timezone: 'auto',
          forecast_days: String(FORECAST_DAYS),
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });

      if (!data.daily) {
        this.log('Invalid forecast data received: daily is missing');
        return [];
      }
      return this.toForecasts(data);
    } catch (e) {
      this.log(
        `Error fetching forecast for ${latitude},${longitude}: ${String(e)}`
      );
      return [];
    }
  }

  /**
   * API レスポンスを表示用の予報リストへ変換する。
   *
   * Open-Meteo は対象地点のタイムゾーンにおける今日を起点に
   * 日付の昇順で予報を返すため、配列インデックスがそのまま
   * 今日からの相対日数に対応する。
   */
  private toForecasts(data: ForecastResponse): WeatherForecast[] {
    const daily = data.daily;
    if (!daily) return [];

    return daily.time.map((date, index) => ({
      date,
      dateLabel: DATE_LABELS[index] ?? `${index}日後`,
      weather: WMO_CODE_MAP[daily.weathercode[index]] ?? UNKNOWN_WMO_CODE,
      tempMax: daily.temperature_2m_max[index] ?? null,
      tempMin: daily.temperature_2m_min[index] ?? null,
      rain: this.toRainChance(data.hourly, date),
    }));
  }

  /**
   * 時間ごとの降水確率を対象日の 6 時間ごとの区間へ集約する。
   *
   * `hourly.time` は対象地点のローカル時刻（ISO 8601 の拡張なし形式）で
   * 返るため、日付と時刻の文字列をそのまま区間判定に使う。
   */
  private toRainChance(
    hourly: ForecastResponse['hourly'],
    date: string
  ): RainChance | null {
    if (!hourly || hourly.time.length === 0) return null;

    const buckets: number[][] = [[], [], [], []];
    for (let i = 0; i < hourly.time.length; i++) {
      const time = hourly.time[i];
      if (!time.startsWith(date)) continue;

      const probability = hourly.precipitation_probability[i];
      if (probability === null || probability === undefined) continue;

      const hour = Number.parseInt(time.slice(11, 13), 10);
      if (Number.isNaN(hour)) continue;
      buckets[Math.floor(hour / 6)].push(probability);
    }

    // 対象日のデータが1つもない場合は降水確率を表示しない
    if (buckets.every((bucket) => bucket.length === 0)) return null;

    const average = (values: number[]): number =>
      values.length === 0
        ? 0
        : Math.round(values.reduce((sum, v) => sum + v, 0) / values.length);

    return {
      T00_06: average(buckets[0]),
      T06_12: average(buckets[1]),
      T12_18: average(buckets[2]),
      T18_24: average(buckets[3]),
    };
  }
}
