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
 * 気象データを含む投稿文からは外さない。
 */
export const ATTRIBUTION =
  '気象データ: Open-Meteo（JMA MSM）https://open-meteo.com/ / CC-BY 4.0 https://creativecommons.org/licenses/by/4.0/';

/** 気圧の変化量を「直近3時間で -2.3 hPa」の形で述べる。 */
export function describeDelta(deltaHpa: number): string {
  return `直近3時間で ${formatDeltaHpa(deltaHpa)} hPa`;
}

/**
 * 警報投稿の本文。
 *
 * レベルの語彙や頭痛の因果は書かない。利用者が自分で確かめられる事実
 * （気圧の変化量）と出典だけを示す。
 */
export function buildAlertMessage(
  locationName: string,
  deltaHpa: number
): string {
  return [
    `気圧が下がってきています（${locationName}付近、${describeDelta(deltaHpa)}）。無理しないでね。`,
    ATTRIBUTION,
  ].join('\n');
}

/**
 * メンションへの返信本文。
 *
 * `deltaHpa` が null のときは数値を出さない。古い値や推定値を
 * 断定した文にしないための分岐で、呼び出し側が鮮度を判断して null を渡す。
 */
export function buildMentionMessage(
  locationName: string,
  deltaHpa: number | null,
  observedAtLocal?: string
): string {
  if (deltaHpa === null) {
    return '気圧データを取得できませんでした。少し待ってからもう一度話しかけてね。';
  }

  const hour = observedAtLocal?.slice(11, 16);
  const suffix = hour ? `（${hour}時点）` : '';

  return [
    `${locationName}付近の気圧は${describeDelta(deltaHpa)} 変化しています${suffix}。`,
    ATTRIBUTION,
  ].join('\n');
}
