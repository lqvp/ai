import { formatDeltaHpa } from './pressure-trend.js';

/**
 * 気圧投稿の文面を組み立てる純粋関数群。
 *
 * `index.ts` から切り離しているのは、文面（特にライセンス表記）を
 * モジュールを起動せずにテストで守るため。
 */

/**
 * 気象データの出典表示。
 *
 * Open-Meteo の利用条件（CC-BY 4.0）は「出典表示」に加えて
 * 「ライセンスと提供元へのリンク」を求めているため、URL を省略しない。
 * 全角閉じ括弧の直後に半角スペースを置き、クライアントを問わず確実にリンク化させる。
 */
export const ATTRIBUTION =
  '気象データ: Open-Meteo（JMA MSM） https://open-meteo.com/ / CC-BY 4.0 https://creativecommons.org/licenses/by/4.0/';

/** 気圧の変化量を「直近3時間で -2.3 hPa」の形で述べる。 */
export function describeDelta(deltaHpa: number): string {
  return `直近3時間で ${formatDeltaHpa(deltaHpa)} hPa`;
}

function normalizeSpot(locationName: string | undefined): string {
  return typeof locationName === 'string' ? locationName.trim() : '';
}

/**
 * 警報投稿の本文。
 *
 * レベルの語彙や頭痛の因果は書かない。利用者が自分で確かめられる事実
 * （気圧の変化量）と出典だけを示す。
 * `locationName` が空（カスタム座標のみで地名未設定）のときは座標を出さず地名を省く。
 */
export function buildAlertMessage(
  locationName: string | undefined,
  deltaHpa: number
): string {
  const spot = normalizeSpot(locationName);
  const detail = spot
    ? `${spot}付近、${describeDelta(deltaHpa)}`
    : describeDelta(deltaHpa);

  return [
    `気圧が下がってきています（${detail}）。無理しないでね。`,
    ATTRIBUTION,
  ].join('\n');
}

export interface MentionMessageOptions {
  /**
   * 返信に予報画像を添付するか。
   * 3時間前の1点だけが欠測で `deltaHpa === null` でも、最新の予報画像を
   * 添付する場合は「取得できませんでした」と矛盾させず、CC-BY 4.0 の出典 URL も付与する。
   */
  hasForecastImage?: boolean;
}

/**
 * メンションへの返信本文。
 *
 * `deltaHpa` が null のときは数値を出さない。古い値や推定値を
 * 断定した文にしないための分岐で、呼び出し側が鮮度を判断して null を渡す。
 */
export function buildMentionMessage(
  locationName: string | undefined,
  deltaHpa: number | null,
  observedAtLocal?: string,
  options?: MentionMessageOptions
): string {
  const spot = normalizeSpot(locationName);
  const hour = observedAtLocal?.slice(11, 16);
  const suffix = hour ? `（${hour}時点）` : '';

  if (deltaHpa === null) {
    if (options?.hasForecastImage) {
      const prefix = spot ? `${spot}付近の` : '';
      return [
        `${prefix}直近3時間の気圧変化は欠測のため計算できませんでした${suffix}。`,
        ATTRIBUTION,
      ].join('\n');
    }
    return '気圧データを取得できませんでした。少し待ってからもう一度話しかけてね。';
  }

  const subject = spot ? `${spot}付近の気圧` : '気圧';

  return [
    `${subject}は${describeDelta(deltaHpa)} 変化しています${suffix}。`,
    ATTRIBUTION,
  ].join('\n');
}
