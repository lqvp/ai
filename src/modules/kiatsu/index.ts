import type { InstallerResult } from '@/ai.js';
import config from '@/config/index.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import type { DriveFile } from '@/misskey/types.js';
import Module from '@/module.js';
import { fetchForecast, type HourlyForecast } from './open-meteo.js';
import {
  type AlertState,
  deltaOverHours,
  evaluateAlert,
  formatDeltaHpa,
  formatLocalHourKey,
  indexOfLocalHour,
} from './pressure-trend.js';
import { renderKiatsuImage } from './render-kiatsu.js';

/**
 * 設定の既定値。
 *
 * 地点は zutool.jp 時代の既定（locationCode '13102' = 東京都中央区）を
 * 引き継いでいる。config が未設定でも同じ場所で動くようにするため、
 * 既定値は schema ではなくこのモジュール側で持つ。
 */
const DEFAULTS = {
  latitude: 35.6702,
  longitude: 139.774,
  locationName: '中央区',
  requestTimeoutMs: 10_000,
  updateIntervalMs: 10 * 60 * 1000,
  alertThresholdHpa: -2.0,
  hysteresisHpa: 0.5,
  maxPostsPerDay: 1,
  maxErrorRetries: 5,
  errorCooldownMs: 60 * 60 * 1000,
} as const;

/** ΔP を評価する時間幅（時間）。 */
const DELTA_HOURS = 3;

/**
 * 気象データの出典表示。
 *
 * Open-Meteo（JMA MSM）の CC-BY 4.0 は帰属表示が義務なので、
 * 気象データを含む投稿文からは外さない。
 */
const ATTRIBUTION = '気象データ: Open-Meteo（JMA MSM）/ CC-BY 4.0';

export default class extends Module {
  public readonly name = 'kiatsu';

  /** 画像生成に使う直近の予報。取得に失敗したときは前回の値を残す。 */
  private latestForecast: HourlyForecast | null = null;

  /**
   * 画像の先頭に出す予報点の添字（＝現在時刻の位置）。
   *
   * 予報は過去1日分（past_days=1）を含むため、そのまま描くと表の大半が
   * 過ぎた時刻になる。利用者が見たいのは「今から先」なので、
   * レンダラへはこの添字以降を切り出して渡す。
   */
  private latestForecastStart = 0;

  /** 直近の ΔP3h。計算できないときは null（メンション応答を「データなし」にする）。 */
  private latestDelta3h: number | null = null;

  /**
   * 警報の状態。投稿したかどうかに関わらず毎回 evaluateAlert の結果で置き換える。
   *
   * これを怠ると、投稿を見送った評価で alerting が立ったままになり、
   * 同じ警報で毎回 trigger してしまう。
   */
  private alertState: AlertState = { alerting: false };

  private errorCount = 0;

  /** 一時停止中は update() を素通りさせる。クールダウン中の再試行を防ぐ。 */
  private suspended = false;

  private postsToday = 0;
  private postsTodayKey: string | null = null;

  @bindThis
  public install(): InstallerResult | false {
    // 無効時は false で打ち切る。
    // ここで {} を返すと、Module.getHooks() がクラスメソッドの mentionHook を
    // 自動登録してしまうため、mentionHook を止められない。
    if (config.kiatsu?.enabled === false) return false;

    this.startMonitoring();
    void this.update(); // 初回実行

    return { mentionHook: this.mentionHook };
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
    // 停止中の呼び出し（mentionHook 経由を含む）では何もしない。
    // ここで失敗を数えると、再開直後の1回でまた閾値に達してしまう。
    if (this.suspended) return;

    this.syncPostDay();

    try {
      const forecast = await fetchForecast({
        latitude: config.kiatsu?.latitude ?? DEFAULTS.latitude,
        longitude: config.kiatsu?.longitude ?? DEFAULTS.longitude,
        timeoutMs: config.kiatsu?.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs,
      });

      // 現在時刻のデータが無くても画像は描けるので、取得できた時点で保持する。
      this.latestForecast = forecast;

      const nowLocal = formatLocalHourKey(new Date());
      const currentIndex = indexOfLocalHour(forecast.hours, nowLocal);

      if (currentIndex < 0) {
        this.log(`現在時刻 (${nowLocal}) の気圧データがありません。`);
        this.handleError();
        return;
      }

      // 画像は「今」から描く。添字を保持しておき、描画時に切り出す。
      this.latestForecastStart = currentIndex;

      const delta3h = deltaOverHours(forecast.hours, currentIndex, DELTA_HOURS);
      this.latestDelta3h = delta3h;

      const { state, trigger } = evaluateAlert(delta3h, this.alertState, {
        thresholdHpa:
          config.kiatsu?.alertThresholdHpa ?? DEFAULTS.alertThresholdHpa,
        hysteresisHpa: config.kiatsu?.hysteresisHpa ?? DEFAULTS.hysteresisHpa,
      });

      // 投稿の有無に関わらず状態は進める（同じ警報の再 trigger を防ぐ）。
      this.alertState = state;

      this.log(
        `気圧トレンドを更新しました: Δ3h=${
          delta3h === null ? '不明' : `${formatDeltaHpa(delta3h)}hPa`
        } (警報中: ${state.alerting})`
      );

      // trigger が立つのは delta3h が計算できたときだけだが、
      // 型を締めるために null チェックを明示する。
      if (trigger && delta3h !== null) {
        if (this.canPostToday()) {
          void this.ai.post({ text: this.buildAlertMessage(delta3h) });
          this.recordPost();
        } else {
          // 日次上限に達している場合も状態遷移は進めているので、ここは見送るだけ。
          this.log('本日の投稿上限に達しているため、警報の投稿は見送ります。');
        }
      }

      // 取得と判定まで通ったときだけ失敗カウントを戻す。
      this.errorCount = 0;
    } catch (error) {
      this.log('気圧データの取得に失敗しました。');
      console.warn(error);
      this.handleError();
    }
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

    // 停止処理はここ1か所だけ。suspended を立てることで、
    // 恒久障害でも「一時停止／再開」を二重投稿しない。
    this.suspended = true;
    this.log('エラーが続いています。監視を一時停止します。');
    void this.ai.post({
      text: 'エラーが続いています。気圧監視を一時停止しました。',
    });

    const cooldownMs =
      config.kiatsu?.errorCooldownMs ?? DEFAULTS.errorCooldownMs;

    this.later(cooldownMs, () => {
      // 再開時にカウントを戻さないと、再開後の1回の失敗でまた閾値に達し、
      // 「停止しました／再開しました」を1時間ごとに永久投稿し続ける。
      this.errorCount = 0;
      this.suspended = false;
      this.log('監視を再開します。');
      void this.ai.post({ text: '気圧監視を再開しました。' });
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
  }

  @bindThis
  private canPostToday(): boolean {
    const maxPostsPerDay =
      config.kiatsu?.maxPostsPerDay ?? DEFAULTS.maxPostsPerDay;

    return this.postsToday < maxPostsPerDay;
  }

  @bindThis
  private recordPost(): void {
    this.postsToday++;
    this.log(`気圧警報を投稿しました（本日 ${this.postsToday} 件目）。`);
  }

  /** 投稿文に出す地点名。未設定でも既定地点で動く。 */
  private get locationName(): string {
    return config.kiatsu?.locationName ?? DEFAULTS.locationName;
  }

  /**
   * 警報投稿の本文。
   *
   * 旧実装のレベル語彙・「頭痛」の因果・絶対気圧は出さない。
   * 検証できる事実（変化量）と出典だけを書く。
   */
  @bindThis
  private buildAlertMessage(delta3h: number): string {
    return [
      `気圧が下がってきています（${this.locationName}付近、3時間で ${formatDeltaHpa(
        delta3h
      )} hPa）。無理しないでね。`,
      ATTRIBUTION,
    ].join('\n');
  }

  @bindThis
  private buildMentionMessage(): string {
    if (this.latestDelta3h === null) {
      return '気圧データを取得できませんでした。少し待ってからもう一度話しかけてね。';
    }

    return [
      `${this.locationName}付近の気圧は3時間で ${formatDeltaHpa(
        this.latestDelta3h
      )} hPa 変化しています。`,
      ATTRIBUTION,
    ].join('\n');
  }

  @bindThis
  private async generateForecastImageFile(): Promise<DriveFile | undefined> {
    if (!this.latestForecast) return undefined;

    // レンダラ側で startIndex 以降を描く。
    // 配列を切り出す方式だと先頭3列の ΔP3h が計算できなくなるため、
    // 過去分（past_days=1）を残したまま開始位置だけ渡す。
    const image = renderKiatsuImage(this.latestForecast, {
      locationName: this.locationName,
      startIndex: this.latestForecastStart,
    });

    return await this.ai.upload(image, {
      filename: 'kiatsu.png',
      contentType: 'image/png',
    });
  }

  @bindThis
  private async mentionHook(message: Message) {
    if (!message.includes(['気圧', 'きあつ', 'kiatsu'])) return false;

    await this.update();

    let file: DriveFile | undefined;

    try {
      file = await this.generateForecastImageFile();
    } catch (error) {
      this.log('気圧画像の生成に失敗しました。テキストのみ返信します。');
      console.warn(error);
    }

    message.reply(this.buildMentionMessage(), {
      immediate: true,
      file,
    });

    return true;
  }
}
