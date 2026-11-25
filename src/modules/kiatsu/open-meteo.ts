/**
 * 気圧モジュール用の Open-Meteo 取得層。
 *
 * 旧実装が依存していた zutool.jp の非公式 API が署名トークン必須になり
 * 機能停止したため、気象庁 MSM を配信する Open-Meteo に置き換える。
 *
 * このファイルは「取ってきて正規化する」ことだけを担当する。
 * 気圧トレンドの判定や表示は呼び出し側の責務にしておき、
 * API の形が変わったときの影響範囲をここへ閉じ込める。
 */

import { getJson } from '@/http/client.js';

export const OPEN_METEO_FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';

/** 取得に使う時間ごとの要素。ここを増やすと parseForecast も追随が必要。 */
const HOURLY_FIELDS = 'pressure_msl,temperature_2m,weather_code';

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * 既定で前日ぶんも取る理由。
 *
 * ΔP3h（3時間の気圧差）は現在時刻の 3 時間前の値が要る。深夜 0〜2 時は
 * 「3時間前」が前日に落ちるため、当日 00:00 始まりの系列だけでは
 * 日界でトレンドが計算できなくなる。
 */
export const DEFAULT_PAST_DAYS = 1;

/**
 * 既定 4 日の理由。
 *
 * MSM（気象庁メソモデル）の予報地平は約 78〜84 時間で、それを超えると
 * 別モデルの値が混ざる。`best_match` は約 85 時間で切り替わるため
 * MSM の地平に揃えて 4 日を上限にする。
 */
export const DEFAULT_FORECAST_DAYS = 4;

export interface HourlyPoint {
  /** 地点のローカル時刻 `YYYY-MM-DDTHH:mm`（分は常に :00） */
  timeLocal: string;
  /** 海面更正気圧 (hPa)。欠測は null */
  pressureMsl: number | null;
  /** 気温 (℃)。欠測は null */
  temperatureC: number | null;
  /** WMO weather code。欠測は null */
  weatherCode: number | null;
}

export interface HourlyForecast {
  latitude: number;
  longitude: number;
  /** API が返す DEM 標高 (m)。欠測は null。表示には使わない（pressure_msl は標高非依存） */
  elevationM: number | null;
  hours: HourlyPoint[];
}

export interface OpenMeteoOptions {
  latitude: number;
  longitude: number;
  timeoutMs?: number;
  /** 既定 1。日界（0〜2時）でも ΔP3h を計算できるようにするため */
  pastDays?: number;
  /** 既定 4（MSM の地平に合わせる） */
  forecastDays?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 欠測を 0 に潰さないための変換。
 *
 * Open-Meteo は MSM の欠測を null で返す。0 hPa / 0℃ と区別できないと
 * トレンド判定が誤るため、数値として有効なときだけ通し、それ以外は null にする。
 * `typeof` で先に弾くので NaN や数値文字列も null に落ちる。
 */
function toFiniteNumberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readCoordinate(
  value: unknown,
  field: 'latitude' | 'longitude'
): number {
  // 0 は赤道・本初子午線として正当なので、真偽値ではなく型で判定する
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Open-Meteo: ${field} is missing or not a number`);
  }
  return value;
}

/** 系列の長さを行ごとに突き合わせる。ずれたまま写像すると時刻と値がずれる。 */
function assertSameLength(
  name: string,
  series: unknown,
  expected: number
): unknown[] {
  if (!Array.isArray(series)) {
    throw new Error(
      `Open-Meteo: hourly.${name} is missing but hourly.time has ${expected} entries`
    );
  }
  if (series.length !== expected) {
    throw new Error(
      `Open-Meteo: hourly.${name} length ${series.length} does not match hourly.time length ${expected}`
    );
  }
  return series;
}

/**
 * レスポンスを検証して正規化する。形が不正なら Error を投げる。
 *
 * 座標は payload の値を使う。API は要求した座標ではなく実際に使った
 * モデル格子点の座標を返すので、地点の同一性はそちらで担保する。
 * parseForecast は payload しか受け取らないため、options で補完はしない。
 */
export function parseForecast(payload: unknown): HourlyForecast {
  if (!isRecord(payload)) {
    throw new Error('Open-Meteo: response is not an object');
  }

  const latitude = readCoordinate(payload.latitude, 'latitude');
  const longitude = readCoordinate(payload.longitude, 'longitude');

  const hourly = payload.hourly;
  if (!isRecord(hourly)) {
    throw new Error('Open-Meteo: hourly is missing');
  }

  const rawTime = hourly.time;
  if (!Array.isArray(rawTime) || rawTime.length === 0) {
    throw new Error('Open-Meteo: hourly.time is missing');
  }

  // 型を絞りながらコピーする。ここで文字列以外を弾いておけば、
  // 以降は timeLocal をキャストせずに扱える
  const time: string[] = [];
  for (let i = 0; i < rawTime.length; i++) {
    const entry = rawTime[i];
    if (typeof entry !== 'string') {
      throw new Error(`Open-Meteo: hourly.time[${i}] is not a string`);
    }
    time.push(entry);
  }

  const pressure = assertSameLength(
    'pressure_msl',
    hourly.pressure_msl,
    time.length
  );
  const temperature = assertSameLength(
    'temperature_2m',
    hourly.temperature_2m,
    time.length
  );
  const weatherCode = assertSameLength(
    'weather_code',
    hourly.weather_code,
    time.length
  );

  const hours: HourlyPoint[] = time.map((timeLocal, index) => ({
    // タイムゾーン変換はしない。timezone=Asia/Tokyo で要求しているので
    // API の文字列がそのまま地点のローカル時刻になっている
    timeLocal,
    pressureMsl: toFiniteNumberOrNull(pressure[index]),
    temperatureC: toFiniteNumberOrNull(temperature[index]),
    weatherCode: toFiniteNumberOrNull(weatherCode[index]),
  }));

  return {
    latitude,
    longitude,
    elevationM: toFiniteNumberOrNull(payload.elevation),
    hours,
  };
}

/**
 * リクエストのクエリを組み立てる。
 *
 * `elevation` は要求しない。`pressure_msl` は海面更正気圧で標高に依存せず、
 * 絶対気圧を表示しない方針のため不要。
 */
export function buildQuery(options: OpenMeteoOptions): Record<string, string> {
  return {
    latitude: String(options.latitude),
    longitude: String(options.longitude),
    hourly: HOURLY_FIELDS,
    // 'auto' ではなく固定。地点ローカルの日界で ΔP3h を扱う前提を明示する
    // （日本は夏時間がないので Asia/Tokyo で十分）
    timezone: 'Asia/Tokyo',
    // best_match は約 85 時間で別モデルへ切り替わり、系列の途中で
    // 気圧の傾向が変わる。MSM に固定して 4 日間を同一モデルで揃える
    models: 'jma_msm',
    past_days: String(options.pastDays ?? DEFAULT_PAST_DAYS),
    forecast_days: String(options.forecastDays ?? DEFAULT_FORECAST_DAYS),
  };
}

/**
 * 取得して parseForecast を通す。失敗は例外で伝える（呼び出し側が処理する）。
 */
export async function fetchForecast(
  options: OpenMeteoOptions
): Promise<HourlyForecast> {
  const payload = await getJson<unknown>(OPEN_METEO_FORECAST_URL, {
    searchParams: buildQuery(options),
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  });

  return parseForecast(payload);
}
