/**
 * 気圧トレンド（ΔP3h）から警報を出す判定ロジック。
 *
 * 旧実装は外部 API が返す「警戒レベル 0〜4」をそのまま使っていた。しかし
 * その式は非公開で、こちらで再現も検証もできない。レベルが動いた理由を
 * 説明できず、テストも書けないため、観測できる量である 3 時間の気圧変化量
 * （ΔP3h）そのものを判定材料にする。
 *
 * ΔP3h に「医学的に正しい閾値」は外部に存在しない。気象病の感受性は個人差が
 * 大きく、公的な基準もない。よって閾値はコードに埋め込まず設定
 * （AlertOptions）として持ち、運用しながら調整できるようにする。
 *
 * 単純な閾値判定だけだと、ΔP3h が閾値の周りを ±0.1 hPa で揺れるたびに
 * 警報と解除を繰り返して投稿が荒ぶる。解除側にだけ幅（ヒステリシス）を
 * 持たせ、閾値を下回って警報に入ったあとは「閾値 + 幅」を明確に超えるまで
 * 解除しない。これで境界付近のノイズでは状態が動かない。
 *
 * このファイルの関数はすべて純粋関数。現在時刻は呼び出し側が渡すので、
 * テストは Date.now() に依存せず決定的に書ける。
 */

import { DEFAULT_TIME_ZONE, getZonedParts } from '@/services/clock.js';
import type { HourlyPoint } from './open-meteo.js';

/** 警報のオン・オフだけを持つ。投稿済みかどうかは呼び出し側の関心事。 */
export interface AlertState {
  alerting: boolean;
}

export interface AlertOptions {
  /** 投稿する閾値（負値）。ΔP3h がこれ以下になったら警報 */
  thresholdHpa: number;
  /** 解除の幅（0以上）。ΔP3h が threshold + hysteresis を超えたら解除 */
  hysteresisHpa: number;
}

/**
 * 既定値。
 *
 * -2 hPa / 3h は「気圧の変化に敏感な人が不調を感じ始める」と言われるあたりを
 * 保守的に取った暫定値で、根拠のある臨床値ではない。運用しながら調整する前提。
 * 解除幅 0.5 hPa は、観測値の丸め（0.1 hPa 程度）と短周期の揺れを吸収する幅。
 */
export const DEFAULT_ALERT_OPTIONS: AlertOptions = Object.freeze({
  thresholdHpa: -2,
  hysteresisHpa: 0.5,
});

/**
 * 比較の許容差（hPa）。
 *
 * 気圧は 0.1 hPa 刻みで返るが、引き算は二進小数の誤差を含む。例えば
 * 1012.4 − 1010.1 は 2.2999999999999545 になり、しきい値 −2.3 と比べると
 * 「下回っていない」と判定されて警報が落ちる。倍精度の誤差は 1e-12 程度
 * なので、その桁だけ吸収する（表示値を丸めるわけではない）。
 */
const COMPARISON_EPSILON = 1e-9;

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * 閾値設定の妥当性を検証する。
 *
 * `evaluateAlert` は毎回検証するが、設定ミスは起動時に検出したい
 * （ティックごとに例外を投げて静かに機能停止するより、起動時に落とす）。
 */
export function validateAlertOptions(options: AlertOptions): void {
  assertValidOptions(options);
}

/**
 * 設定ミスを黙って通さないための検証。
 *
 * - threshold が 0 以上だと「下回ったら警報」が成立しない（0 は常時警報になる）。
 * - 解除幅が負だと解除条件が閾値より下になり、警報に入った直後に解除され続ける。
 * - NaN / Infinity は比較が常に false になるため、判定が静かに壊れる。
 * いずれも呼び出し側の設定バグなので、既定値で握りつぶさず例外にする。
 */
function assertValidOptions(options: AlertOptions): void {
  const { thresholdHpa, hysteresisHpa } = options;

  if (!Number.isFinite(thresholdHpa) || thresholdHpa >= 0) {
    throw new Error(
      `AlertOptions.thresholdHpa must be a finite negative number, got ${thresholdHpa}`
    );
  }
  if (!Number.isFinite(hysteresisHpa) || hysteresisHpa < 0) {
    throw new Error(
      `AlertOptions.hysteresisHpa must be a finite non-negative number, got ${hysteresisHpa}`
    );
  }
}

/**
 * Date を `YYYY-MM-DDTHH:00` に整形する（純粋関数）。
 *
 * Open-Meteo から受け取る `timeLocal` と同じ形式に揃えるためのもの。
 * 実行環境のタイムゾーンに依存させないため、`Intl` の `timeZone` を明示的に
 * 渡す（既定は Asia/Tokyo）。分・秒は捨てて正時キーにする。
 */
export function formatLocalHourKey(
  date: Date,
  timeZone: string = DEFAULT_TIME_ZONE
): string {
  const { year, month, day, hour } = getZonedParts(date, timeZone);
  return `${year}-${pad2(month)}-${pad2(day)}T${pad2(hour)}:00`;
}

/** timeLocal が targetLocal と一致する最初の要素の添字。無ければ -1 */
export function indexOfLocalHour(
  hours: HourlyPoint[],
  targetLocal: string
): number {
  return hours.findIndex((hour) => hour.timeLocal === targetLocal);
}

/**
 * hours[targetIndex] と hours[targetIndex - k] の pressureMsl の差。
 *
 * どちらかが欠測（null）なら null、添字が範囲外でも null。欠測を 0 と
 * みなすと「変化なし」に化けて判定を誤るため、null は null のまま返す。
 * k は 1 以上の整数（このモジュールでは 3 を想定）。
 */
export function deltaOverHours(
  hours: HourlyPoint[],
  targetIndex: number,
  k: number
): number | null {
  if (!Number.isInteger(k) || k < 1) return null;
  if (!Number.isInteger(targetIndex)) return null;
  if (targetIndex < 0 || targetIndex >= hours.length) return null;

  const previousIndex = targetIndex - k;
  if (previousIndex < 0) return null;

  const current = hours[targetIndex].pressureMsl;
  const previous = hours[previousIndex].pressureMsl;
  if (current === null || previous === null) return null;

  return current - previous;
}

/**
 * 警報状態を進める。入力の state は変更せず、常に新しいオブジェクトを返す。
 *
 * - delta3h が null（欠測）: 判定材料が無いので状態を動かさない。欠測を
 *   0 とみなすと「変化なし」として解除してしまい、データが欠けるたびに
 *   黙って警報が消える。安全側に倒して据え置く（trigger もしない）。
 * - 解除は threshold + hysteresis を「超えた」ときだけ。境界ちょうどで
 *   解除すると、閾値ちょうどの警報判定と合わせて境界で振動しうる。
 */
export function evaluateAlert(
  delta3h: number | null,
  state: AlertState,
  options: AlertOptions
): { state: AlertState; trigger: boolean } {
  assertValidOptions(options);

  if (delta3h === null) {
    return { state: { alerting: state.alerting }, trigger: false };
  }

  if (!state.alerting) {
    const trigger = delta3h <= options.thresholdHpa + COMPARISON_EPSILON;
    return { state: { alerting: trigger }, trigger };
  }

  const release = delta3h > options.thresholdHpa + options.hysteresisHpa;
  return { state: { alerting: !release }, trigger: false };
}

/**
 * 符号付きで小数1桁に整形する（例: `-2.3`, `+1.2`, `0.0`）。
 *
 * 変化量は「下がった / 上がった」の向きが本質なので、正値にも `+` を付ける。
 * 0 は向きが無いので符号を付けない。`-0.04` は丸めると `-0` になるが、
 * `-0 === 0` なので符号なしの `0.0` に落ちる。
 * delta は有限値を前提とする（取得層が NaN を null に落としている）。
 */
export function formatDeltaHpa(delta: number): string {
  const rounded = Math.round(delta * 10) / 10;
  if (rounded === 0) return '0.0';

  // 絶対値で整形してから符号を付ける。負値に toFixed すると '-0.0' が
  // 出うるが、上で 0 を弾いているのでここでは起きない。
  const text = Math.abs(rounded).toFixed(1);
  return rounded < 0 ? `-${text}` : `+${text}`;
}

/** バックオフ倍率の上限（1時間 × 16 = 16時間）。 */
const MAX_BACKOFF_SHIFT = 4;

/**
 * 連続停止が続いたときの再試行までの待ち時間。
 *
 * 恒久障害では「停止 → 待機 → 再開 → また停止」を無限に繰り返すため、
 * 待機時間を指数的に伸ばして相手への負荷とログの量を抑える。
 * 上限を設けるのは、復帰したときに長すぎる空白を残さないため。
 */
export function backoffDelayMs(
  baseMs: number,
  suspensionCount: number
): number {
  if (!Number.isFinite(baseMs) || baseMs <= 0) {
    throw new Error(
      `backoffDelayMs: baseMs must be a finite positive number, got ${baseMs}`
    );
  }

  const count = Number.isFinite(suspensionCount)
    ? Math.max(0, Math.floor(suspensionCount))
    : 0;

  return baseMs * 2 ** Math.min(count, MAX_BACKOFF_SHIFT);
}

/**
 * この停止を利用者に知らせるか。
 *
 * 同じ障害が長引くときに「停止しました／再開しました」を出し続けると
 * タイムラインが埋まるので、通知は上限回数までにする（復帰は試み続ける）。
 */
export function shouldNotifySuspension(
  noticedCount: number,
  limit: number
): boolean {
  if (!Number.isFinite(limit) || limit < 0) {
    throw new Error(
      `shouldNotifySuspension: limit must be a non-negative number, got ${limit}`
    );
  }

  return noticedCount < limit;
}
