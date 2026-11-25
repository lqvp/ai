import type { InstallerResult } from '@/ai.js';
import config from '@/config/index.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import type { DriveFile } from '@/misskey/types.js';
import Module from '@/module.js';
import { todayKey } from '@/services/clock.js';
import { buildAlertMessage, buildMentionMessage } from './messages.js';
import { fetchForecast, type HourlyForecast } from './open-meteo.js';
import {
  type AlertOptions,
  type AlertState,
  backoffDelayMs,
  COMPARISON_EPSILON,
  DEFAULT_ALERT_OPTIONS,
  deltaOverHours,
  evaluateAlert,
  formatLocalHourKey,
  formatLocalMinuteKey,
  indexOfLocalHour,
  shouldNotifySuspension,
  validateAlertOptions,
} from './pressure-trend.js';
import { renderKiatsuImage } from './render-kiatsu.js';

/**
 * 設定の既定値。
 *
 * 地点は zutool.jp 時代の既定（locationCode '13102' = 東京都中央区）を
 * 引き継いでいる。config が未設定でも同じ場所で動くようにするため、
 * 既定値は schema ではなくこのモジュール側で持つ。
 * 閾値とヒステリシスは判定層の既定値をそのまま使う（二重定義を避ける）。
 */
const DEFAULTS = {
  latitude: 35.6702,
  longitude: 139.774,
  locationName: '中央区',
  requestTimeoutMs: 10_000,
  updateIntervalMs: 10 * 60 * 1000,
  ...DEFAULT_ALERT_OPTIONS,
  maxPostsPerDay: 1,
  maxErrorRetries: 5,
  errorCooldownMs: 60 * 60 * 1000,
} as const;

/** ΔP を評価する時間幅（時間）。 */
const DELTA_HOURS = 3;

/** 現在時刻のキーが見つからないときに探す前後の幅（時間）。 */
const FALLBACK_HOURS = 1;

/**
 * 停止・再開を通知する上限回数。
 *
 * 恒久障害では「停止 → クールダウン → 再開 → また停止」を延々と繰り返す。
 * 通知を無制限に出すとタイムラインが埋まるので、同じ障害の連鎖では
 * 最初の数回だけ知らせ、以降はログに落とす（復帰は自動で試み続ける）。
 */
const NOTICE_LIMIT = 2;

/** 未送信の警報を諦めるまでの試行回数。 */
const MAX_ALERT_ATTEMPTS = 3;

/**
 * 諦めたあと、同じ低下で再挑戦するまでの間隔。
 *
 * 投稿だけが失敗している場合、警報状態を解除しないと Misskey が復旧しても
 * その低下の警報が二度と出せない。かといって毎ティック試すと失敗を繰り返すので、
 * 一定時間だけ間隔を空けて再挑戦する。
 */
const ALERT_RETRY_SUPPRESS_MS = 30 * 60 * 1000;

/** これより古い予報・ΔP はメンション応答や保留警報に使わない（鮮度切れ）。 */
const STALE_MS = 2 * 60 * 60 * 1000;

const HOUR_MS = 60 * 60 * 1000;

/**
 * `YYYY-MM-DDTHH:mm` を Asia/Tokyo のミリ秒へ変換する。
 *
 * 予報の時刻はタイムゾーン表記を持たないローカル時刻なので、`new Date(str)` に
 * 渡すと実行環境のタイムゾーンで解釈されてしまう。明示的に +09:00 を付ける。
 */
function parseLocalHourMs(timeLocal: string): number | null {
  const ms = Date.parse(`${timeLocal}:00+09:00`);
  return Number.isNaN(ms) ? null : ms;
}

/** 旧設定キー。読み込まれても使われないため、起動時に警告する。 */
const LEGACY_KEYS = ['locationCode', 'postIntervalMs', 'minPostLevel'] as const;

/** 再起動をまたいで保持する状態（日次上限と警報フラグ）。 */
type KiatsuData = {
  /** 状態を保存したときの地点。地点を変えたら状態は引き継がない */
  spot?: string;
  /** 状態を保存したときの閾値。閾値を変えたら古い警報状態は引き継がない */
  thresholdHpa?: number;
  /** 保存時刻（ミリ秒）。長時間停止後の再起動で古い警報を引き継がないために使う */
  savedAtMs?: number;
  alerting?: boolean;
  /** 未送信の警報が残っているか（短時間の再起動で取りこぼさないため） */
  pending?: boolean;
  postsToday?: number;
  postsTodayKey?: string | null;
};

type EvaluateParams = {
  /** タイムラインへの投稿（警報・停止通知・再開通知）を許可するか */
  allowPost: boolean;
  /** 失敗・回復を定期監視のエラーカウンタに反映するか */
  countErrors: boolean;
};

type ForecastSnapshot = {
  forecast: HourlyForecast | null;
  startIndex: number;
  fetchedAtLocal: string | null;
  fetchedAtMs: number | null;
  delta3h: number | null;
  observedAtLocal: string | null;
  observedAtMs: number | null;
};

export default class extends Module<KiatsuData> {
  public readonly name = 'kiatsu';

  /** 画像生成に使う直近の予報。取得に失敗したときは前回の値を残す。 */
  private latestForecast: HourlyForecast | null = null;

  /**
   * 画像の先頭に出す予報点の添字（＝現在時刻の位置）。
   *
   * 予報は過去1日分（past_days=1）を含むため、そのまま描くと表の大半が
   * 過ぎた時刻になる。利用者が見たいのは「今から先」なので、
   * レンダラへはこの添字以降を描かせる。
   */
  private latestForecastStart = 0;

  /**
   * 予報を取得した時刻（`YYYY-MM-DDTHH:mm`）。
   *
   * 画像に「取得: M/D HH:mm」として出す。描画した時刻ではなく取得した実時刻を渡す。
   */
  private latestForecastFetchedAt: string | null = null;

  /** 直近で予報取得に成功した時刻（ミリ秒）。キャッシュの鮮度判定に使う。 */
  private latestForecastFetchedAtMs: number | null = null;

  /** 直近で予報取得を試行した時刻（ミリ秒）。失敗・時刻不一致時を含むメンション再試行の間隔制限に使う。 */
  private lastFetchAttemptAtMs: number | null = null;

  /** 直近の ΔP3h。計算できないときは null。 */
  private latestDelta3h: number | null = null;

  /**
   * 評価した予報点の時刻（ミリ秒）。
   *
   * 鮮度は「取得時刻」ではなく予報点の時刻から測る。20:50 に 20:00 の点を
   * 取った場合、22:40 の時点で予報は 2時間40分前のものだから。
   */
  private latestObservedAtMs: number | null = null;

  /**
   * 警報の状態。投稿したかどうかに関わらず毎回 evaluateAlert の結果で置き換える。
   *
   * これを怠ると、投稿を見送った評価で alerting が立たないままになり、
   * 同じ警報で毎回 trigger してしまう。
   */
  private alertState: AlertState = { alerting: false };

  /**
   * 有効な ΔP3h（非 null）を最後に評価した時刻（ミリ秒）。
   *
   * 日次枠のリセット（`syncPostDay`）や欠測（`delta3h === null`）では進めない。
   * 取得失敗中に日付をまたいで再起動したとき、古い警報状態の鮮度時刻まで
   * 新しく上書きしてしまうのを防ぐ。
   */
  private lastAlertEvaluatedAtMs: number | null = null;

  /**
   * 送信待ちの警報があるか。投稿に失敗したら次回以降に再試行する。
   *
   * 値ではなくフラグで持つのは、送る直前にそのときの変化量を使うため。
   */
  private pendingAlert = false;

  /** 未送信警報の試行回数。無限に再試行しないための上限。 */
  private pendingAlertAttempts = 0;

  /** この時刻までは未送信警報の再挑戦をしない（諦めた直後の間隔）。 */
  private alertRetryAfter = 0;

  /** 投稿処理の多重実行を防ぐ。 */
  private posting = false;

  /**
   * `evaluate()` の直列化チェーン。
   *
   * `every()` は単一タイマー内の重なりしか防がないため、初回実行・クールダウン再開・
   * メンション応答が重なったときの Out-of-order 上書きや二重評価をここで防ぐ。
   */
  private evaluationQueue: Promise<void> = Promise.resolve();

  /** 現在進行中の評価 Promise（メンション側が相乗りするために保持）。 */
  private inFlightEvaluation: Promise<void> | null = null;

  private errorCount = 0;

  /** 現在時刻の予報点が見つからない状態が連続した回数。単発は許容し、連続時は障害扱いする。 */
  private consecutiveMissingHours = 0;

  /** 一時停止中は定期評価を素通りさせる。クールダウン中の再試行を防ぐ。 */
  private suspended = false;

  /** 連続した停止の回数。クールダウンの指数バックオフに使う。 */
  private consecutiveSuspensions = 0;

  /** 通知済みの停止回数。NOTICE_LIMIT を超えたら黙って再試行する。 */
  private noticedSuspensions = 0;

  /** 停止中に再開したことを、取得成功後に一度だけ知らせるためのフラグ。 */
  private pendingResumeNotice = false;

  private postsToday = 0;
  private postsTodayKey: string | null = null;

  @bindThis
  public install(): InstallerResult | false {
    // 無効時は false で打ち切る。
    // ここで {} を返すと、Module.getHooks() がクラスメソッドの mentionHook を
    // 自動登録してしまうため、mentionHook を止められない。
    if (config.kiatsu?.enabled === false) return false;

    this.warnLegacyKeys();
    this.restoreState();

    // 設定ミスは起動時に落とす。ティックごとに evaluateAlert が例外を投げると、
    // エラーログだけが出て機能が静かに止まる。
    try {
      validateAlertOptions(this.alertOptions);
    } catch (error) {
      this.log(`気圧監視の設定が不正なため起動しません: ${String(error)}`);
      console.warn(error);
      return false;
    }

    this.startMonitoring();

    return { mentionHook: this.mentionHook };
  }

  /**
   * 旧キーが設定に残っていれば警告する。
   *
   * 旧 `locationCode` は黙って無視され、地点が既定（中央区）に戻る。
   * 利用者が別地点を指定していた場合、気づかないまま違う地点の予報を
   * 投稿し続けることになるため、起動時に1回だけ知らせる。
   */
  private warnLegacyKeys(): void {
    const kiatsu = config.kiatsu as Record<string, unknown> | undefined;
    if (!kiatsu) return;

    const found = LEGACY_KEYS.filter((key) => kiatsu[key] !== undefined);
    if (found.length === 0) return;

    this.log(
      `廃止された設定キーを無視しました: ${found.join(', ')}。` +
        '地点は latitude / longitude / locationName で指定してください。'
    );
  }

  @bindThis
  private startMonitoring(): void {
    // 投稿判断はこの評価ループだけに集約する。別タイマーで定期投稿すると
    // 3時間変化のピークを捕まえ損ねたり、同じ警報を二重投稿する原因になる。
    // immediate: true で初回実行も同じ running ガードに乗せる。
    this.every(
      config.kiatsu?.updateIntervalMs ?? DEFAULTS.updateIntervalMs,
      this.update,
      { immediate: true }
    );
  }

  @bindThis
  private async update(): Promise<void> {
    await this.enqueueEvaluation({ allowPost: true, countErrors: true });
  }

  /**
   * 評価処理を直列キューに積んで実行する。
   */
  private enqueueEvaluation(params: EvaluateParams): Promise<void> {
    const run = this.evaluationQueue.then(
      () => this.evaluateInternal(params),
      () => this.evaluateInternal(params)
    );
    const settled = run.catch((error) => {
      this.log(`気圧評価中に予期しない例外が発生しました: ${String(error)}`);
      console.warn(error);
    });
    this.evaluationQueue = settled;
    const tracked = settled.finally(() => {
      if (this.inFlightEvaluation === tracked) {
        this.inFlightEvaluation = null;
      }
    });
    this.inFlightEvaluation = tracked;
    return tracked;
  }

  /**
   * 予報を取り直して判定する（直列キュー内部からのみ呼ぶ）。
   *
   * - `allowPost` が false のとき（メンション応答用）はタイムラインに一切投稿しない。
   * - `countErrors` が false のときは一時的なメンション集中で `errorCount` を
   *   進めない（数秒の瞬断中に話しかけられただけで1時間停止するのを防ぐ）。
   */
  private async evaluateInternal(params: EvaluateParams): Promise<void> {
    const { allowPost, countErrors } = params;

    // 停止中の呼び出しでは何もしない。
    if (this.suspended) return;

    this.syncPostDay();

    let forecast: HourlyForecast;
    this.lastFetchAttemptAtMs = Date.now();

    try {
      forecast = await fetchForecast({
        latitude: config.kiatsu?.latitude ?? DEFAULTS.latitude,
        longitude: config.kiatsu?.longitude ?? DEFAULTS.longitude,
        timeoutMs: config.kiatsu?.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      });
    } catch (error) {
      this.log('気圧データの取得に失敗しました。');
      console.warn(error);
      if (countErrors) {
        this.consecutiveMissingHours = 0;
        await this.handleError();
      }
      return;
    }

    const now = new Date();
    const currentIndex = this.findCurrentIndex(forecast, now);

    if (currentIndex < 0) {
      // 単発の時刻ずれ（1回分）はネットワーク失敗と区別して様子を見るが、
      // API の書式変更や配信停止で連続して該当時刻が無い場合は、無限に空振りし続けないよう
      // 通常の失敗カウントに乗せて指数バックオフへ移行させる。
      this.log(
        `現在時刻 (${formatLocalHourKey(now)}) 付近の気圧データがありません。`
      );
      if (countErrors) {
        this.consecutiveMissingHours++;
        if (this.consecutiveMissingHours >= 2) {
          await this.handleError();
        }
      }
      return;
    }

    this.consecutiveMissingHours = 0;

    // 使える時刻が見つかってから差し替える。先に保持すると、開始位置だけ
    // 古いまま新しい予報を描き、過去の列を「今」として出すことになる。
    this.latestForecast = forecast;
    this.latestForecastFetchedAt = formatLocalMinuteKey(now);
    this.latestForecastFetchedAtMs = now.getTime();
    this.latestForecastStart = currentIndex;

    const delta3h = deltaOverHours(forecast.hours, currentIndex, DELTA_HOURS);
    const observedAt = forecast.hours[currentIndex].timeLocal;

    this.latestDelta3h = delta3h;
    this.latestObservedAtMs = parseLocalHourMs(observedAt);
    if (delta3h !== null) {
      this.lastAlertEvaluatedAtMs = now.getTime();
    }

    const { state, trigger } = evaluateAlert(
      delta3h,
      this.alertState,
      this.alertOptions
    );

    // 投稿の有無に関わらず状態は進める（同じ警報の再 trigger を防ぐ）。
    // 送信に失敗したときは、状態とは別に「未送信」として抱える。
    this.alertState = state;

    // 警報が解除されたら未送信の警報も再試行抑制も捨てる。
    // 抑制タイマーを残すと、直後に別の急降下が来たときに邪魔をする。
    if (!state.alerting) {
      this.pendingAlert = false;
      this.pendingAlertAttempts = 0;
      this.alertRetryAfter = 0;
    }

    if (trigger && delta3h !== null && !this.pendingAlert) {
      this.pendingAlert = true;
      this.pendingAlertAttempts = 0;
    }

    this.persistState();

    this.log(
      `気圧トレンドを更新しました: Δ3h=${
        delta3h === null ? '不明' : `${delta3h.toFixed(1)}hPa`
      } (警報中: ${state.alerting})`
    );

    if (allowPost) {
      await this.flushPendingAlert();
    }

    if (countErrors) {
      await this.onRecovered();
    }
  }

  /**
   * 現在時刻に対応する予報点の添字を返す。
   *
   * 完全一致が無い場合は ±1 時間まで探す。時刻の丸めや API 側の書式変更で
   * 1時間ずれることがあり、そのたびに「データが無い」と扱うのは乱暴なため。
   */
  @bindThis
  private findCurrentIndex(
    forecast: HourlyForecast,
    now: Date,
    options: { silent?: boolean } = {}
  ): number {
    const exact = indexOfLocalHour(forecast.hours, formatLocalHourKey(now));
    if (exact >= 0) return exact;

    for (let offset = 1; offset <= FALLBACK_HOURS; offset++) {
      // 過去を優先する。未来の点を選ぶと「（21:00時点）」のような
      // 未来時刻を観測時刻として返してしまう。
      for (const sign of [-1, 1]) {
        const shifted = new Date(now.getTime() + sign * offset * HOUR_MS);
        const index = indexOfLocalHour(
          forecast.hours,
          formatLocalHourKey(shifted)
        );
        if (index >= 0) {
          if (!options.silent) {
            this.log(
              `現在時刻のデータが無いため ${offset} 時間${sign > 0 ? '後' : '前'}の点を使います。`
            );
          }
          return index;
        }
      }
    }

    return -1;
  }

  /**
   * 未送信の警報があれば送る。
   */
  @bindThis
  private async flushPendingAlert(): Promise<void> {
    if (!this.pendingAlert || this.posting) return;

    // 諦めた直後は間隔を空ける。ただし未送信フラグは保持したままなので、
    // 待機が明ければ次の評価で送信される。
    if (Date.now() < this.alertRetryAfter) return;

    // 送る直前に最新の変化量を使う。鮮度が切れていたら警報状態ごと戻して破棄する
    // （alerting だけ残すと、復帰後も低下が続いているのに再発火できなくなる）。
    if (
      this.latestObservedAtMs !== null &&
      Date.now() - this.latestObservedAtMs > STALE_MS
    ) {
      this.log('未送信の警報は鮮度が切れたため破棄します。');
      this.pendingAlert = false;
      this.pendingAlertAttempts = 0;
      this.alertRetryAfter = 0;
      this.alertState = { alerting: false };
      this.lastAlertEvaluatedAtMs = null;
      this.persistState();
      return;
    }

    const delta3h = this.latestDelta3h;
    if (delta3h === null) {
      // 一時的な欠測。警報は解除されていないので、未送信のまま延期する。
      this.log('気圧データが欠測しているため、警報の送信を延期します。');
      return;
    }

    // 発火しきい値より浅い（ヒステリシス帯まで回復しかけている）場合や、
    // 小数1桁への丸めで 0.0 以上になる場合は、しきい値未満の数値で遅れて
    // 警報を出さない。まだエピソード自体は解除されていないので、再び
    // しきい値以下へ深掘りしたときだけ送れるよう保留のまま見送る。
    const roundedTenths = Math.round(delta3h * 10) / 10;
    if (
      roundedTenths >= 0 ||
      delta3h > this.alertOptions.thresholdHpa + COMPARISON_EPSILON
    ) {
      this.log(
        '現在の気圧変化量が警報しきい値に達していないため、警報の送信を見送ります。'
      );
      return;
    }

    // 日付をまたいだ直後に前日の枠で判定しないよう、投稿直前に同期する。
    this.syncPostDay();

    if (!this.canPostToday()) {
      // 日次上限に達している場合も判定は進めているので、ここは見送るだけ。
      this.log('本日の投稿上限に達しているため、警報の投稿は見送ります。');
      return;
    }

    this.posting = true;

    try {
      await this.ai.post({
        text: buildAlertMessage(this.displayLocationName, delta3h),
      });
      this.pendingAlert = false;
      this.pendingAlertAttempts = 0;
      this.alertRetryAfter = 0;
      // 投稿できたときだけ枠を消費する（失敗で枠だけ減るのを避ける）。
      this.recordPost();
    } catch (error) {
      this.pendingAlertAttempts++;
      this.log(
        `警報の投稿に失敗しました（${this.pendingAlertAttempts}/${MAX_ALERT_ATTEMPTS} 回目）。`
      );
      console.warn(error);

      if (this.pendingAlertAttempts >= MAX_ALERT_ATTEMPTS) {
        // 何度試しても通らないなら一旦間隔を空ける。未送信フラグは残すので、
        // 待機が明けて Misskey が復旧していれば同じ低下のまま送信される。
        this.log(
          `警報の投稿を保留します。${ALERT_RETRY_SUPPRESS_MS / 60000} 分後に再挑戦します。`
        );
        this.pendingAlertAttempts = 0;
        this.alertRetryAfter = Date.now() + ALERT_RETRY_SUPPRESS_MS;
      }
    } finally {
      this.posting = false;
    }
  }

  /** 例外を外へ漏らさずに通知ノートを投稿する（UnhandledRejection 防止）。 */
  private async safePostNotice(text: string): Promise<void> {
    try {
      await this.ai.post({ text });
    } catch (error) {
      this.log(`通知の投稿に失敗しました: ${text}`);
      console.warn(error);
    }
  }

  /** 取得に成功したときの後始末。再開通知もここで1回だけ出す。 */
  @bindThis
  private async onRecovered(): Promise<void> {
    if (this.suspended) return;

    this.errorCount = 0;
    this.consecutiveSuspensions = 0;
    this.noticedSuspensions = 0;

    if (!this.pendingResumeNotice) return;

    this.pendingResumeNotice = false;
    await this.safePostNotice('気圧監視を再開しました。');
  }

  @bindThis
  private async handleError(): Promise<void> {
    if (this.suspended) return;

    this.errorCount++;

    const maxErrorRetries =
      config.kiatsu?.maxErrorRetries ?? DEFAULTS.maxErrorRetries;

    if (this.errorCount <= maxErrorRetries) return;

    this.suspended = true;

    const cooldownMs =
      config.kiatsu?.errorCooldownMs ?? DEFAULTS.errorCooldownMs;
    const backoffMs = backoffDelayMs(cooldownMs, this.consecutiveSuspensions);

    this.consecutiveSuspensions++;
    this.log(
      `エラーが続いています。監視を一時停止します（${Math.round(backoffMs / 60000)} 分後に再試行）。`
    );

    // クールダウンタイマーは通知投稿の成否に関わらず先に仕掛ける
    this.later(backoffMs, () => {
      // 再開時にカウントを戻さないと、再開後の1回の失敗や単発の時刻ずれでまた閾値に達する。
      this.errorCount = 0;
      this.consecutiveMissingHours = 0;
      this.suspended = false;
      // 「再開しました」は取得に成功した時点で出す。
      this.pendingResumeNotice = true;
      this.log('一時停止期間が終了しました。監視を再開します。');
      void this.update();
    });

    if (shouldNotifySuspension(this.noticedSuspensions, NOTICE_LIMIT)) {
      this.noticedSuspensions++;
      await this.safePostNotice(
        'エラーが続いています。気圧監視を一時停止しました。'
      );
    } else {
      // 障害が長引いている。通知は打ち切り、復帰だけ試み続ける。
      this.log('停止の通知は上限に達したため省略します。');
    }
  }

  /** 日付が変わっていたら日次投稿カウントを戻す。 */
  @bindThis
  private syncPostDay(): void {
    const today = todayKey();

    if (this.postsTodayKey === today) return;

    this.postsTodayKey = today;
    this.postsToday = 0;
    this.persistState();
  }

  @bindThis
  private canPostToday(): boolean {
    const maxPostsPerDay =
      config.kiatsu?.maxPostsPerDay ?? DEFAULTS.maxPostsPerDay;

    return this.postsToday < maxPostsPerDay;
  }

  @bindThis
  private recordPost(): void {
    // 送信中に日付が変わった場合に備え、確定時点の日付で数える。
    this.syncPostDay();
    this.postsToday++;
    this.persistState();
    this.log(`気圧警報を投稿しました（本日 ${this.postsToday} 件目）。`);
  }

  /** 設定されている地点を表すキー。地点変更の検出に使う。 */
  private get spotKey(): string {
    const latitude = config.kiatsu?.latitude ?? DEFAULTS.latitude;
    const longitude = config.kiatsu?.longitude ?? DEFAULTS.longitude;
    return `${latitude},${longitude}`;
  }

  /** 再起動をまたいで状態を読み戻す。 */
  private restoreState(): void {
    const data = this.getData();

    // 日次投稿枠は地点や閾値に依存しないので、設定が変わっても必ず読み戻す。
    this.postsToday = typeof data.postsToday === 'number' ? data.postsToday : 0;
    this.postsTodayKey = data.postsTodayKey ?? null;

    const spotChanged = data.spot !== undefined && data.spot !== this.spotKey;
    const thresholdChanged =
      data.thresholdHpa !== undefined &&
      data.thresholdHpa !== this.alertOptions.thresholdHpa;
    const savedAtMs =
      typeof data.savedAtMs === 'number' ? data.savedAtMs : null;
    const hasSavedAlertState = data.alerting === true || data.pending === true;
    const stateExpired =
      savedAtMs !== null
        ? Date.now() - savedAtMs > STALE_MS
        : hasSavedAlertState;

    if (spotChanged || thresholdChanged || stateExpired) {
      // 地点変更・閾値変更・長時間停止後の再起動では、古い警報状態を引き継がない。
      this.log(
        '設定変更または長時間経過のため、前回の警報状態は引き継ぎません。'
      );
      this.alertState = { alerting: false };
      this.pendingAlert = false;
      this.alertRetryAfter = 0;
      this.lastAlertEvaluatedAtMs = null;
      this.persistState();
    } else {
      this.alertState = { alerting: data.alerting === true };
      this.pendingAlert = data.pending === true;
      this.lastAlertEvaluatedAtMs = savedAtMs;
    }

    // 日付が変わっていれば上限はリセットされる（syncPostDay と同じ規則）。
    this.syncPostDay();
  }

  /** 再起動をまたいで保持したい状態を保存する。 */
  private persistState(): void {
    this.setData({
      spot: this.spotKey,
      thresholdHpa: this.alertOptions.thresholdHpa,
      savedAtMs: this.lastAlertEvaluatedAtMs ?? undefined,
      alerting: this.alertState.alerting,
      pending: this.pendingAlert,
      postsToday: this.postsToday,
      postsTodayKey: this.postsTodayKey,
    });
  }

  /** 判定に使う閾値。評価と起動時検証で同じ値を使う。 */
  private get alertOptions(): AlertOptions {
    return {
      thresholdHpa: config.kiatsu?.alertThresholdHpa ?? DEFAULTS.thresholdHpa,
      hysteresisHpa: config.kiatsu?.hysteresisHpa ?? DEFAULTS.hysteresisHpa,
    };
  }

  /**
   * 投稿文と画像に出す地点名（プライバシ保護のため座標は返さない）。
   *
   * - `locationName` が設定されていればその表示名を使う。
   * - 座標も `locationName` も未設定なら既定地点の「中央区」を返す（本文・画像とも一致）。
   * - 利用者がカスタム座標だけを設定して `locationName` を省略した場合は
   *   `undefined` を返し、公開ノートや画像に自宅付近の座標が載らないようにする。
   */
  private get displayLocationName(): string | undefined {
    const rawName = config.kiatsu?.locationName;
    const configured = typeof rawName === 'string' ? rawName.trim() : '';
    if (configured) return configured;

    const usesDefaultCoordinates =
      config.kiatsu?.latitude === undefined &&
      config.kiatsu?.longitude === undefined;

    return usesDefaultCoordinates ? DEFAULTS.locationName : undefined;
  }

  private isSnapshotFresh(
    snapshot: ForecastSnapshot,
    nowMs: number = Date.now()
  ): boolean {
    return (
      snapshot.forecast !== null &&
      snapshot.fetchedAtMs !== null &&
      nowMs - snapshot.fetchedAtMs <= STALE_MS &&
      snapshot.observedAtMs !== null &&
      nowMs - snapshot.observedAtMs <= STALE_MS
    );
  }

  /**
   * メンション応答の前に、必要なら予報を更新する。
   *
   * - 進行中の評価があればそれに相乗りする。
   * - 成否を問わず直近 `updateIntervalMs` 以内に取得を試行済みなら再取得しない
   *   （取得失敗中や時刻不一致中に連続メンションが来ても外部 API を叩き続けないようにする）。
   * - キャッシュ自体の鮮度判定には引き続き取得成功時刻を使う。
   */
  private async ensureFreshForMention(): Promise<void> {
    if (this.inFlightEvaluation) {
      await this.inFlightEvaluation;
      return;
    }

    const updateIntervalMs =
      config.kiatsu?.updateIntervalMs ?? DEFAULTS.updateIntervalMs;
    const nowMs = Date.now();
    if (
      this.lastFetchAttemptAtMs !== null &&
      nowMs - this.lastFetchAttemptAtMs < updateIntervalMs
    ) {
      return;
    }

    await this.enqueueEvaluation({ allowPost: false, countErrors: false });
  }

  /**
   * メンション返信用のスナップショットを現在の返信時刻に合わせて切り出す。
   *
   * 20:58 に取得した予報キャッシュを 21:03 に再利用する場合でも、配列内に 21:00 の点が
   * あれば現在時刻の添字と ΔP3h へ進めて返す（警報状態や日次枠は動かさない）。
   */
  private captureSnapshot(now: Date = new Date()): ForecastSnapshot {
    const forecast = this.latestForecast;
    if (!forecast) {
      return {
        forecast: null,
        startIndex: 0,
        fetchedAtLocal: null,
        fetchedAtMs: null,
        delta3h: null,
        observedAtLocal: null,
        observedAtMs: null,
      };
    }

    const currentIndex = this.findCurrentIndex(forecast, now, { silent: true });
    if (currentIndex < 0) {
      return {
        forecast,
        startIndex: this.latestForecastStart,
        fetchedAtLocal: this.latestForecastFetchedAt,
        fetchedAtMs: this.latestForecastFetchedAtMs,
        delta3h: null,
        observedAtLocal: null,
        observedAtMs: null,
      };
    }

    const observedAtLocal = forecast.hours[currentIndex].timeLocal;
    return {
      forecast,
      startIndex: currentIndex,
      fetchedAtLocal: this.latestForecastFetchedAt,
      fetchedAtMs: this.latestForecastFetchedAtMs,
      delta3h: deltaOverHours(forecast.hours, currentIndex, DELTA_HOURS),
      observedAtLocal,
      observedAtMs: parseLocalHourMs(observedAtLocal),
    };
  }

  private async deleteDriveFileBestEffort(fileId: string): Promise<void> {
    try {
      await this.ai.api?.('drive/files/delete', { fileId });
    } catch (error) {
      this.log(`不要になった予報画像の削除に失敗しました: ${fileId}`);
      console.warn(error);
    }
  }

  @bindThis
  private async generateForecastImageFile(
    snapshot: ForecastSnapshot,
    locationName: string | undefined
  ): Promise<DriveFile | undefined> {
    if (!snapshot.forecast) return undefined;

    const image = renderKiatsuImage(snapshot.forecast, {
      locationName,
      startIndex: snapshot.startIndex,
      thresholdHpa: this.alertOptions.thresholdHpa,
      fetchedAtLocal: snapshot.fetchedAtLocal ?? undefined,
      nowLocal: formatLocalHourKey(new Date()),
    });

    return await this.ai.upload(image, {
      filename: 'kiatsu.png',
      contentType: 'image/png',
    });
  }

  @bindThis
  private async mentionHook(message: Message) {
    if (!message.includes(['気圧', 'きあつ', 'kiatsu'])) return false;

    await this.ensureFreshForMention();

    const snapshot = this.captureSnapshot();
    const locationName = this.displayLocationName;

    // 予報自体が鮮度切れのときは古い画像を添付しない（本文「取得できませんでした」との矛盾と
    // 出典 URL 欠落を同時に防ぐ）。
    let file: DriveFile | undefined;
    if (this.isSnapshotFresh(snapshot)) {
      try {
        file = await this.generateForecastImageFile(snapshot, locationName);
      } catch (error) {
        this.log('気圧画像の生成に失敗しました。テキストのみ返信します。');
        console.warn(error);
      }
    }

    // 画像アップロード中に鮮度上限（STALE_MS）を超えることがあるため、返信直前に再判定して揃える。
    // 不要になった画像の削除は返信を遅らせないよう完了を待たずに実行する。
    const replyIsFresh = this.isSnapshotFresh(snapshot);
    if (file !== undefined && !replyIsFresh) {
      void this.deleteDriveFileBestEffort(file.id);
    }
    const replyFile = replyIsFresh ? file : undefined;
    const deltaForReply = replyIsFresh ? snapshot.delta3h : null;

    try {
      await message.reply(
        buildMentionMessage(
          locationName,
          deltaForReply,
          replyIsFresh ? (snapshot.observedAtLocal ?? undefined) : undefined,
          { hasForecastImage: replyFile !== undefined }
        ),
        {
          immediate: true,
          file: replyFile,
        }
      );
    } catch (error) {
      this.log('メンションへの返信に失敗しました。');
      console.warn(error);
    }

    return true;
  }
}
