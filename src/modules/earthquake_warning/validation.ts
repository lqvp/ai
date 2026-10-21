import { convertIntensityToNumber } from './format.js';
import type { P2PQuakeTsunamiData, WolfxEarthquakeData } from './types.js';

const REQUIRED_FIELDS = [
  'type',
  'EventID',
  'AnnouncedTime',
  'Hypocenter',
  'Latitude',
  'Longitude',
  'Magunitude',
  'Depth',
  'MaxIntensity',
] as const;

/**
 * Wolfx の地震データが期待する形かどうかを検証する。
 */
export function validateEarthquakeData(
  data: unknown,
  log: (message: string) => void = () => {}
): data is WolfxEarthquakeData {
  if (!data || typeof data !== 'object') return false;

  for (const field of REQUIRED_FIELDS) {
    if (!(field in data)) {
      log(`地震データに必須フィールド ${field} がありません`);
      return false;
    }
  }

  const record = data as Record<string, unknown>;

  if (
    typeof record.EventID !== 'string' ||
    typeof record.Hypocenter !== 'string' ||
    typeof record.MaxIntensity !== 'string'
  ) {
    log('地震データの型が正しくありません');
    return false;
  }

  if (
    Number.isNaN(Number(record.Latitude)) ||
    Number.isNaN(Number(record.Longitude)) ||
    Number.isNaN(Number(record.Magunitude)) ||
    Number.isNaN(Number(record.Depth))
  ) {
    log('地震データの数値フィールドが無効です');
    return false;
  }

  return true;
}

export function validateTsunamiData(
  data: unknown
): data is P2PQuakeTsunamiData {
  if (!data || typeof data !== 'object') return false;

  const tsunamiData = data as Partial<P2PQuakeTsunamiData>;

  if (typeof tsunamiData.id !== 'string') return false;
  if (tsunamiData.code !== 552) return false;
  if (typeof tsunamiData.time !== 'string') return false;
  if (typeof tsunamiData.cancelled !== 'boolean') return false;
  if (!tsunamiData.issue || typeof tsunamiData.issue !== 'object') return false;
  if (
    typeof tsunamiData.issue.time !== 'string' ||
    typeof tsunamiData.issue.type !== 'string'
  ) {
    return false;
  }
  if (tsunamiData.areas !== undefined && !Array.isArray(tsunamiData.areas)) {
    return false;
  }

  return true;
}

export type ReportThreshold = {
  /** これ未満の震度は報告しない */
  minIntensity: number;
  /** 震度4未満の場合に要求するマグニチュード */
  minMagnitudeForWeak: number;
};

/**
 * 設定された閾値を満たす地震かどうか。
 */
export function shouldReportEarthquake(
  data: WolfxEarthquakeData,
  threshold: ReportThreshold
): boolean {
  const intensityValue = convertIntensityToNumber(data.MaxIntensity);

  if (intensityValue < threshold.minIntensity) {
    return false;
  }

  if (intensityValue < 4 && data.Magunitude < threshold.minMagnitudeForWeak) {
    return false;
  }

  return true;
}
