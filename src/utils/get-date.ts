import { getZonedParts } from '@/services/clock.js';

/**
 * `Y/M/D` 形式の日付文字列（event キー用）。
 * タイムゾーンは Asia/Tokyo 固定。
 */
export default function (): string {
  const { year, month, day } = getZonedParts();
  return `${year}/${month}/${day}`;
}
