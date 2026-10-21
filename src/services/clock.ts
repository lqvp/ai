/**
 * タイムゾーンを固定した日時ユーティリティ。
 *
 * これまで `new Date().getHours()`（プロセスのローカル時刻）と
 * `date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })` が混在していた。
 * ここでは Intl.DateTimeFormat の formatToParts を使い、実行環境の TZ に依存せず
 * Asia/Tokyo の年月日・時刻を取得する。
 */

export const DEFAULT_TIME_ZONE = 'Asia/Tokyo';

const WEEKDAYS_JA = ['日', '月', '火', '水', '木', '金', '土'] as const;

export type ZonedParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 0 (日) - 6 (土)
};

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function getFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatterCache.get(timeZone);
  if (formatter) return formatter;

  formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    weekday: 'short',
    hour12: false,
  });
  formatterCache.set(timeZone, formatter);
  return formatter;
}

const WEEKDAY_INDEX: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

/**
 * 指定タイムゾーンでの年月日・時刻を返す。
 */
export function getZonedParts(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): ZonedParts {
  const parts = getFormatter(timeZone).formatToParts(date);
  const values: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== 'literal') values[part.type] = part.value;
  }

  // 24:00 を返す環境があるため 0 時に正規化する
  const hour = Number.parseInt(values.hour ?? '0', 10) % 24;

  return {
    year: Number.parseInt(values.year ?? '1970', 10),
    month: Number.parseInt(values.month ?? '1', 10),
    day: Number.parseInt(values.day ?? '1', 10),
    hour,
    minute: Number.parseInt(values.minute ?? '0', 10),
    second: Number.parseInt(values.second ?? '0', 10),
    weekday: WEEKDAY_INDEX[values.weekday ?? 'Sun'] ?? 0,
  };
}

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

/**
 * `YYYY-MM-DD` 形式の日付キー。
 */
export function todayKey(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): string {
  const { year, month, day } = getZonedParts(date, timeZone);
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

/**
 * `MM-DD` 形式の日付キー（誕生日比較用）。
 */
export function monthDayKey(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): string {
  const { month, day } = getZonedParts(date, timeZone);
  return `${pad2(month)}-${pad2(day)}`;
}

export function nowHour(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): number {
  return getZonedParts(date, timeZone).hour;
}

export function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

/**
 * 1年の残り日数（当日を含む）。
 */
export function daysLeftInYear(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): number {
  const { year, month, day } = getZonedParts(date, timeZone);
  const total = isLeapYear(year) ? 366 : 365;
  const dayOfYear = Math.floor(
    (Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000
  );
  return total - dayOfYear;
}

/**
 * `YYYY年 M月 D日 (ddd)` 形式の日本語日付。
 */
export function formatJapaneseDate(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): string {
  const { year, month, day, weekday } = getZonedParts(date, timeZone);
  return `${year}年 ${month}月 ${day}日 (${WEEKDAYS_JA[weekday]})`;
}

/**
 * `YYYY/MM/DD HH:mm` 形式（プロンプト用）。
 */
export function formatDateTime(
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): string {
  const { year, month, day, hour, minute } = getZonedParts(date, timeZone);
  return `${year}/${pad2(month)}/${pad2(day)} ${pad2(hour)}:${pad2(minute)}`;
}

/**
 * 指定タイムゾーンでの「次の HH:00:00」までのミリ秒。
 */
export function msUntilNextHour(
  hour: number,
  date: Date = new Date(),
  timeZone: string = DEFAULT_TIME_ZONE
): number {
  const parts = getZonedParts(date, timeZone);
  const targetInZone = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    hour,
    0,
    0,
    0
  );
  const nowInZone = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );

  let diff = targetInZone - nowInZone;
  if (diff <= 0) diff += 24 * 60 * 60 * 1000;
  return diff;
}
