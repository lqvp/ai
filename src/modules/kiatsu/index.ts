import type { InstallerResult } from '@/ai.js';
import config from '@/config/index.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import type { DriveFile } from '@/misskey/types.js';
import Module from '@/module.js';
import { buildAlertMessage, buildMentionMessage } from './messages.js';
import { fetchForecast, type HourlyForecast } from './open-meteo.js';
import {
  type AlertOptions,
  type AlertState,
  backoffDelayMs,
  DEFAULT_ALERT_OPTIONS,
  deltaOverHours,
  evaluateAlert,
  formatLocalHourKey,
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

/** これより古い ΔP はメンション応答に出さない（鮮度切れ）。 */
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
  alerting?: boolean;
  /** 未送信の警報が残っているか（再起動で取りこぼさないため） */
  pending?: boolean;
  postsToday?: number;
  postsTodayKey?: string | null;
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
   * 予報を取得した時刻（ローカル時刻キー）。
   *
   * 画像に「取得: HH:MM」として出す。描画した時刻ではなく**取得した時刻**を
   * 渡さないと、取得に失敗して古い予報を描いたときに最新に見えてしまう。
   */
  private latestForecastFetchedAt: string | null = null;

  /** 直近の ΔP3h。計算できないときは null。 */
  private latestDelta3h: number | null = null;

  /**
   * 評価した予報点の時刻（ミリ秒）。
   *
   * 鮮度は「取得時刻」ではなく**予報点の時刻**から測る。20:50 に 20:00 の点を
   * 取った場合、22:40 の時点で予報は 2時間40分前のものだから。
   */
  private latestObservedAtMs: number | null = null;

  /** `latestDelta3h` の観測時刻（ローカル時刻キー）。返信に添える。 */
  private latestObservedAt: string | null = null;

  /**
   * 警報の状態。投稿したかどうかに関わらず毎回 evaluateAlert の結果で置き換える。
   *
   * これを怠ると、投稿を見送った評価で alerting が立ったままになり、
   * 同じ警報で毎回 trigger してしまう。
   */
  private alertState: AlertState = { alerting: false };

  /**
   * 送信待ちの警報があるか。投稿に失敗したら次回以降に再試行する。
   *
   * 値ではなくフラグで持つのは、送る直前に**そのときの**変化量を使うため。
   * 日次上限で見送ったまま日付が変わると、前日の変化量を「直近3時間」として
   * 投稿してしまう。
   */
  private pendingAlert = false;

  /** 未送信警報の試行回数。無限に再試行しないための上限。 */
  private pendingAlertAttempts = 0;

  /** 投稿処理の多重実行を防ぐ（タイマーと他の経路が重なったとき）。 */
  private posting = false;

  private errorCount = 0;

  /** 一時停止中は update() を素通りさせる。クールダウン中の再試行を防ぐ。 */
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
    void this.update(); // 初回実行

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
    // every() は前回の実行が終わるまで次を呼ばないので、遅い取得でも重ならない。
    this.every(
      config.kiatsu?.updateIntervalMs ?? DEFAULTS.updateIntervalMs,
      this.update
    );
  }

  @bindThis
  private async update(): Promise<void> {
    await this.evaluate(true);
  }

  /**
   * 予報を取り直して判定する。
   *
   * `allowPost` が false のときは投稿しない（メンション応答用）。
   * 話しかけられただけで警報が出ると、利用者の意図しないタイミングで
   * タイムラインに投稿してしまうため、返信のための更新では投稿しない。
   */
  private async evaluate(allowPost: boolean): Promise<void> {
    // 停止中の呼び出し（mentionHook 経由を含む）では何もしない。
    // ここで失敗を数えると、再開直後の1回でまた閾値に達してしまう。
    if (this.suspended) return;

    this.syncPostDay();

    let forecast: HourlyForecast;

    try {
      forecast = await fetchForecast({
        latitude: config.kiatsu?.latitude ?? DEFAULTS.latitude,
        longitude: config.kiatsu?.longitude ?? DEFAULTS.longitude,
        timeoutMs: config.kiatsu?.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      });
    } catch (error) {
      this.log('気圧データの取得に失敗しました。');
      console.warn(error);
      this.handleError();
      return;
    }

    // 現在時刻のデータが無くても画像は描けるので、取得できた時点で保持する。
    this.latestForecast = forecast;
    this.latestForecastFetchedAt = formatLocalHourKey(new Date());

    const now = new Date();
    const currentIndex = this.findCurrentIndex(forecast, now);

    if (currentIndex < 0) {
      // 時刻キーの不一致は「取得失敗」ではない。ここでエラー回数を増やすと、
      // API の時刻書式が変わっただけで停止・再開の通知ループに入る。
      this.log(
        `現在時刻 (${formatLocalHourKey(now)}) 付近の気圧データがありません。`
      );
      // 取得自体は成功しているので、連続失敗としては数えない。
      // ここで数えると、時刻書式の変更だけで停止しきい値に達してしまう。
      this.errorCount = 0;
      return;
    }

    this.latestForecastStart = currentIndex;

    const delta3h = deltaOverHours(forecast.hours, currentIndex, DELTA_HOURS);
    const observedAt = forecast.hours[currentIndex].timeLocal;

    this.latestDelta3h = delta3h;
    this.latestObservedAtMs = parseLocalHourMs(observedAt);
    this.latestObservedAt = observedAt;

    const { state, trigger } = evaluateAlert(
      delta3h,
      this.alertState,
      this.alertOptions
    );

    // 投稿の有無に関わらず状態は進める（同じ警報の再 trigger を防ぐ）。
    // 送信に失敗したときは、状態とは別に「未送信」として抱える。
    this.alertState = state;
    this.persistState();

    // 警報が解除されたら未送信の警報も捨てる。解除済みの古い警報を
    // あとから投稿するのは、状況と食い違う。
    if (!state.alerting && this.pendingAlert) {
      this.pendingAlert = false;
      this.pendingAlertAttempts = 0;
      this.persistState();
    }

    this.log(
      `気圧トレンドを更新しました: Δ3h=${
        delta3h === null ? '不明' : `${delta3h.toFixed(1)}hPa`
      } (警報中: ${state.alerting})`
    );

    if (trigger && delta3h !== null && !this.pendingAlert) {
      this.pendingAlert = true;
      this.pendingAlertAttempts = 0;
      this.persistState();
    }

    if (allowPost) {
      await this.flushPendingAlert();
    }

    // 取得と判定まで通ったので、失敗カウントと連続停止をリセットする。
    this.onRecovered();
  }

  /**
   * 現在時刻に対応する予報点の添字を返す。
   *
   * 完全一致が無い場合は ±1 時間まで探す。時刻の丸めや API 側の書式変更で
   * 1時間ずれることがあり、そのたびに「データが無い」と扱うのは乱暴なため。
   */
  @bindThis
  private findCurrentIndex(forecast: HourlyForecast, now: Date): number {
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
          this.log(
            `現在時刻のデータが無いため ${offset} 時間${sign > 0 ? '後' : '前'}の点を使います。`
          );
          return index;
        }
      }
    }

    return -1;
  }

  /**
   * 未送信の警報があれば送る。
   *
   * 投稿処理は多重実行しない。タイマーとメンション経由の更新が重なると、
   * 同じ警報を2回送ってしまうため。
   */
  @bindThis
  private async flushPendingAlert(): Promise<void> {
    if (!this.pendingAlert || this.posting) return;

    // 送る直前に最新の変化量を使う。鮮度が切れていたら諦める
    // （前日の変化量を「直近3時間」として投稿しない）。
    const delta3h = this.currentDelta();
    if (delta3h === null) {
      this.log('未送信の警報は鮮度が切れたため破棄します。');
      this.pendingAlert = false;
      this.pendingAlertAttempts = 0;
      this.persistState();
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
        text: buildAlertMessage(this.locationName, delta3h),
      });
      this.pendingAlert = false;
      this.pendingAlertAttempts = 0;
      this.persistState();
      // 投稿できたときだけ枠を消費する（失敗で枠だけ減るのを避ける）。
      this.recordPost();
    } catch (error) {
      this.pendingAlertAttempts++;
      this.log(
        `警報の投稿に失敗しました（${this.pendingAlertAttempts}/${MAX_ALERT_ATTEMPTS} 回目）。`
      );
      console.warn(error);

      if (this.pendingAlertAttempts >= MAX_ALERT_ATTEMPTS) {
        // 何度試しても通らないなら諦める。古い警報を延々と抱えない。
        this.log('警報の投稿を諦めます。');
        this.pendingAlert = false;
        this.pendingAlertAttempts = 0;
        this.persistState();
      }
    } finally {
      this.posting = false;
    }
  }

  /** 取得に成功したときの後始末。再開通知もここで1回だけ出す。 */
  @bindThis
  private onRecovered(): void {
    this.errorCount = 0;
    this.consecutiveSuspensions = 0;
    this.noticedSuspensions = 0;

    if (!this.pendingResumeNotice) return;

    this.pendingResumeNotice = false;
    void this.ai.post({ text: '気圧監視を再開しました。' });
  }

  @bindThis
  private handleError(): void {
    // 停止の多重実行を防ぐ。interval の評価と mentionHook 経由の update() が
    // 重なると、両方がここへ来て「一時停止」を二重投稿し、クールダウンの
    // タイマーも二重に仕掛かってしまう。
    if (this.suspended) return;

    this.errorCount++;

    const maxErrorRetries =
      config.kiatsu?.maxErrorRetries ?? DEFAULTS.maxErrorRetries;

    if (this.errorCount <= maxErrorRetries) return;

    this.suspended = true;
    this.log('エラーが続いています。監視を一時停止します。');

    if (shouldNotifySuspension(this.noticedSuspensions, NOTICE_LIMIT)) {
      this.noticedSuspensions++;
      void this.ai.post({
        text: 'エラーが続いています。気圧監視を一時停止しました。',
      });
    } else {
      // 障害が長引いている。通知は打ち切り、復帰だけ試み続ける。
      this.log('停止の通知は上限に達したため省略します。');
    }

    const cooldownMs =
      config.kiatsu?.errorCooldownMs ?? DEFAULTS.errorCooldownMs;
    const backoffMs = backoffDelayMs(cooldownMs, this.consecutiveSuspensions);

    this.consecutiveSuspensions++;

    this.later(backoffMs, () => {
      // 再開時にカウントを戻さないと、再開後の1回の失敗でまた閾値に達する。
      this.errorCount = 0;
      this.suspended = false;
      // 「再開しました」は取得に成功した時点で出す。再開しただけで
      // 失敗し続けているのに成功を報せない（実際に直ったか区別できない）。
      this.pendingResumeNotice = true;
      this.log(
        `監視を再開します（次回の試行まで ${backoffMs / 60000} 分待機）。`
      );
      void this.update();
    });
  }

  /** 日付が変わっていたら日次投稿カウントを戻す。 */
  @bindThis
  private syncPostDay(): void {
    const today = formatLocalHourKey(new Date()).slice(0, 10);

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

  /** 再起動をまたいだ状態を読み戻す。 */
  private restoreState(): void {
    const data = this.getData();

    // 地点が変わっていたら、前の地点の警報状態は持ち越さない。
    // 持ち越すと、新しい地点で最初の低下を取りこぼす。
    if (data.spot !== undefined && data.spot !== this.spotKey) {
      this.log('地点が変わったため、警報状態は引き継ぎません。');
      this.alertState = { alerting: false };
      this.postsToday = 0;
      this.postsTodayKey = null;
      this.persistState();
      return;
    }

    this.alertState = { alerting: data.alerting === true };
    this.pendingAlert = data.pending === true;
    this.postsToday = typeof data.postsToday === 'number' ? data.postsToday : 0;
    this.postsTodayKey = data.postsTodayKey ?? null;

    // 日付が変わっていれば上限はリセットされる（syncPostDay と同じ規則）。
    this.syncPostDay();
  }

  /** 再起動をまたいで保持したい状態を保存する。 */
  private persistState(): void {
    this.setData({
      spot: this.spotKey,
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
   * 投稿文に出す地点名。
   *
   * `locationName` が未設定でも既定名（中央区）を出してはいけない。
   * 利用者が緯度経度だけを設定した場合、実際には別の地点の予報なのに
   * 「中央区」と名乗ることになる。名前が無ければ座標で示す。
   */
  private get locationName(): string {
    const configured = config.kiatsu?.locationName?.trim();
    if (configured) return configured;

    const latitude = config.kiatsu?.latitude ?? DEFAULTS.latitude;
    const longitude = config.kiatsu?.longitude ?? DEFAULTS.longitude;

    const isDefaultSpot =
      latitude === DEFAULTS.latitude && longitude === DEFAULTS.longitude;

    return isDefaultSpot
      ? DEFAULTS.locationName
      : `${latitude.toFixed(2)}, ${longitude.toFixed(2)}`;
  }

  /** 画像の地点ラベル。未設定ならレンダラに座標を描かせる。 */
  private get renderLocationName(): string | undefined {
    const configured = config.kiatsu?.locationName?.trim();
    return configured ? configured : undefined;
  }

  /** 鮮度の切れた ΔP は返信に出さない（古い値を断定しない）。 */
  private currentDelta(): number | null {
    if (this.latestDelta3h === null || this.latestObservedAtMs === null) {
      return null;
    }

    return Date.now() - this.latestObservedAtMs > STALE_MS
      ? null
      : this.latestDelta3h;
  }

  @bindThis
  private async generateForecastImageFile(): Promise<DriveFile | undefined> {
    if (!this.latestForecast) return undefined;

    // レンダラ側で startIndex 以降を描く。
    // 配列を切り出す方式だと先頭3列の ΔP3h が計算できなくなるため、
    // 過去分（past_days=1）を残したまま開始位置だけ渡す。
    const image = renderKiatsuImage(this.latestForecast, {
      locationName: this.renderLocationName,
      startIndex: this.latestForecastStart,
      thresholdHpa: config.kiatsu?.alertThresholdHpa ?? DEFAULTS.thresholdHpa,
      fetchedAtLocal: this.latestForecastFetchedAt ?? undefined,
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

    await this.evaluate(false);

    let file: DriveFile | undefined;

    try {
      file = await this.generateForecastImageFile();
    } catch (error) {
      this.log('気圧画像の生成に失敗しました。テキストのみ返信します。');
      console.warn(error);
    }

    message.reply(
      buildMentionMessage(
        this.locationName,
        this.currentDelta(),
        this.latestObservedAt ?? undefined
      ),
      {
        immediate: true,
        file,
      }
    );

    return true;
  }
}
