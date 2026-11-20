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
  hourly?: HourlyPrecipitation;
}

/** 時間ごとの降水確率（対象地点のローカル時刻）。 */
export interface HourlyPrecipitation {
  time: string[];
  precipitation_probability: (number | null)[];
}

/** `YYYY-MM-DD` 形式の日付に対する翌日の日付。 */
function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * 時間ごとの降水確率を対象日の 6 時間ごとの区間へ集約する。
 *
 * Open-Meteo の `precipitation_probability` は時刻 T において
 *「T-1 時〜T 時の1時間」の降水確率を表す。`hourly.time` は対象地点の
 * ローカル時刻で返るため、各サンプルはその1時間前の時間帯に割り当てる
 * （翌日 00:00 のサンプルは対象日の 18-24 時台に属する）。
 *
 * 各区間の値は時間ごとの確率の平均ではなく最大値を採る。
 * 平均では「6時間のどこかで降水がある確率」を表せないため、
 * 傘の要否を判断する指標として最悪値を示す。
 *
 * @returns 対象日のデータが1つもない場合、または hourly がない場合に null。
 *   各区間にデータがない場合、その区間の値は null になる。
 */
export function toRainChance(
  hourly: HourlyPrecipitation | undefined,
  date: string
): RainChance | null {
  if (!hourly || hourly.time.length === 0) return null;

  const buckets: number[][] = [[], [], [], []];
  const nextDate = nextDay(date);

  for (let i = 0; i < hourly.time.length; i++) {
    const time = hourly.time[i];
    const sampleDate = time.slice(0, 10);
    const hour = Number.parseInt(time.slice(11, 13), 10);
    if (Number.isNaN(hour)) continue;

    let bucketIndex: number;
    if (hour === 0) {
      // 翌日 00:00 のサンプルは対象日の 23-24 時台に属する
      if (sampleDate !== nextDate) continue;
      bucketIndex = 3;
    } else if (sampleDate === date) {
      bucketIndex = Math.floor((hour - 1) / 6);
    } else {
      continue;
    }

    const probability = hourly.precipitation_probability[i];
    if (probability === null || probability === undefined) continue;

    buckets[bucketIndex].push(probability);
  }

  if (buckets.every((bucket) => bucket.length === 0)) return null;

  const max = (values: number[]): number | null =>
    values.length === 0 ? null : Math.max(...values);

  return {
    T00_06: max(buckets[0]),
    T06_12: max(buckets[1]),
    T12_18: max(buckets[2]),
    T18_24: max(buckets[3]),
  };
}

/**
 * API レスポンスを表示用の予報リストへ変換する。
 *
 * Open-Meteo は対象地点のタイムゾーンにおける今日を起点に
 * 日付の昇順で予報を返すため、配列インデックスがそのまま
 * 今日からの相対日数に対応する。
 */
function toForecasts(data: ForecastResponse): WeatherForecast[] {
  const daily = data.daily;
  if (!daily) return [];

  return daily.time.slice(0, FORECAST_DAYS).map((date, index) => ({
    date,
    dateLabel: DATE_LABELS[index] ?? `${index}日後`,
    weather: WMO_CODE_MAP[daily.weathercode[index]] ?? UNKNOWN_WMO_CODE,
    tempMax: daily.temperature_2m_max[index] ?? null,
    tempMin: daily.temperature_2m_min[index] ?? null,
    rain: toRainChance(data.hourly, date),
  }));
}

/**
 * Open-Meteo API との通信と地名解決。
 */
export class WeatherApi {
  constructor(private readonly log: (message: string) => void) {}

  /**
   * 地名を検索して座標を解決する。
   *
   * Open-Meteo の地名検索は3文字未満の地名で結果を返さないため、
   * 短い地名には自治体の接尾辞を補って再検索する。
   *
   * @returns 見つからなかった場合に null
   * @throws リクエストが失敗した場合
   */
  public async searchLocation(query: string): Promise<GeocodingResult | null> {
    const candidates =
      query.length >= 3
        ? [query]
        : [`${query}都`, `${query}府`, `${query}県`, `${query}市`];

    for (const name of candidates) {
      const data = await getJson<{ results?: GeocodingResult[] }>(
        OPEN_METEO_GEOCODING_URL,
        {
          searchParams: {
            name,
            count: '1',
            language: 'ja',
            // 旧実装（JMA の国内エリア）に合わせて日本国内の地名に絞る
            countryCode: 'JP',
            format: 'json',
          },
          timeoutMs: REQUEST_TIMEOUT_MS,
        }
      );
      const result = data.results?.[0];
      if (result) return result;
    }
    return null;
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
          // 最終日の翌日 00:00 のサンプル（最終日の 23-24 時台）を
          // 含めるため、表示対象より1日多く取得する
          forecast_days: String(FORECAST_DAYS + 1),
        },
        timeoutMs: REQUEST_TIMEOUT_MS,
      });

      if (!data.daily) {
        this.log('Invalid forecast data received: daily is missing');
        return [];
      }
      return toForecasts(data);
    } catch (e) {
      this.log(
        `Error fetching forecast for ${latitude},${longitude}: ${String(e)}`
      );
      return [];
    }
  }
}
