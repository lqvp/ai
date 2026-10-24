import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import { getJson } from '@/http/client.js';
import Message from '@/message.js';
import type { DriveFile } from '@/misskey/drive-file.js';
import Module from '@/module.js';
import { nowHour } from '@/services/clock.js';
import { renderKiatsuImage, type WeatherData } from './render-kiatsu.js';

export default class extends Module {
  public readonly name = 'kiatsu';

  private currentPressure: string = '';
  private currentPressureLevel: string = '0';
  private currentLocationName: string = '不明な地点';
  private latestWeatherData: WeatherData | null = null;
  private updateIntervalId: NodeJS.Timeout | null = null;
  private postIntervalId: NodeJS.Timeout | null = null;
  private errorCount = 0;

  private readonly stringPressureLevel: {
    [key: string]: (locationName: string, hPa: string) => string;
  } = {
    '0': (locationName, hPa) =>
      `${locationName}の気圧は${hPa}hPaだから問題ないかも。無理しないでね。`,
    '1': (locationName, hPa) =>
      `${locationName}の気圧は${hPa}hPaだから問題ないかも。無理しないでね。`,
    '2': (locationName, hPa) =>
      `${locationName}の気圧が${hPa}hPaでちょっとやばいかも。無理しないでね。`,
    '3': (locationName, hPa) =>
      `${locationName}の気圧が${hPa}hPaでやばいかも！頭痛とか起きやすいから、ゆっくり休んでね。`,
    '4': (locationName, hPa) =>
      `${locationName}の気圧が${hPa}hPaでかなりやばいかも！体調に気をつけてね。頭痛や気分の変化があったら休憩してね。`,
  };

  @bindThis
  public install() {
    this.startMonitoring();
    this.update(); // 初回実行

    return {
      mentionHook: this.mentionHook,
    };
  }

  protected onDispose(): void {
    if (this.updateIntervalId) {
      clearInterval(this.updateIntervalId);
      this.updateIntervalId = null;
    }
    if (this.postIntervalId) {
      clearInterval(this.postIntervalId);
      this.postIntervalId = null;
    }
  }

  @bindThis
  private startMonitoring(): void {
    // 設定された間隔で気圧データを更新
    this.updateIntervalId = setInterval(
      this.update,
      config.kiatsu?.updateIntervalMs ?? 10 * 60 * 1000
    );

    // 設定された間隔で投稿（レベルが高い場合のみ）
    this.postIntervalId = setInterval(
      this.post,
      config.kiatsu?.postIntervalMs ?? 12 * 60 * 60 * 1000
    );
  }

  @bindThis
  private async update() {
    try {
      const locationCode = config.kiatsu?.locationCode ?? '13102';
      const url = `https://zutool.jp/api/getweatherstatus/${locationCode}`;

      this.log(`気圧データ取得中... URL: ${url}`);

      const data = await getJson<WeatherData>(url, {
        timeoutMs: config.kiatsu?.requestTimeoutMs ?? 10_000,
        retryLimit: 1,
      });

      // 基本チェック
      if (!data || !data.today || !Array.isArray(data.today)) {
        this.log('Invalid data format received.');
        this.handleError();
        return;
      }

      const hour = nowHour().toString();
      const hourData = data.today.find((item) => item.time === hour);

      if (!hourData) {
        this.log(`現在の時間 (${hour}) のデータが見つかりません。`);
        this.handleError();
        return;
      }

      this.currentPressureLevel = hourData.pressure_level;
      this.currentPressure = hourData.pressure;
      this.currentLocationName = data.place_name || '不明な地点';
      this.latestWeatherData = data;

      // APIから地点名を取得して表示
      this.log(
        `地点名: ${this.currentLocationName}, 気圧データを更新しました: ${this.currentPressure}hPa (レベル: ${this.currentPressureLevel})`
      );

      // エラーカウントをリセット
      this.errorCount = 0;
    } catch (error) {
      this.log('Failed to fetch weather status.');
      console.warn(error);
      this.handleError();
    }
  }

  @bindThis
  private handleError(): void {
    this.errorCount++;

    const maxErrors = config.kiatsu?.maxErrorRetries ?? 5;

    // エラーが閾値以上続くと監視を一時停止
    if (this.errorCount > maxErrors) {
      this.log('エラーが続いています。監視を一時停止します。');
      this.ai.post({
        text: 'エラーが続いています。気圧監視を一時停止しました。',
      });

      if (this.updateIntervalId) {
        clearInterval(this.updateIntervalId);
        this.updateIntervalId = null;
      }

      if (this.postIntervalId) {
        clearInterval(this.postIntervalId);
        this.postIntervalId = null;
      }

      // 設定された時間後に再開
      const cooldownMs = config.kiatsu?.errorCooldownMs ?? 60 * 60 * 1000;

      this.later(cooldownMs, () => {
        this.log('監視を再開します。');
        this.ai.post({
          text: '気圧監視を再開しました。',
        });
        this.startMonitoring();
        this.update();
      });
    }
  }

  @bindThis
  private post() {
    const minPostLevel = config.kiatsu?.minPostLevel ?? 2;
    const currentLevel = Number.parseInt(this.currentPressureLevel, 10);

    if (Number.isNaN(currentLevel)) return;

    // 設定された最小レベル未満の場合は投稿しない
    if (currentLevel < minPostLevel) return;

    this.ai.post({
      text: this.buildPressureMessage(),
    });
  }

  @bindThis
  private buildPressureMessage(): string {
    if (!this.currentPressure) {
      return `${this.currentLocationName}の気圧データを取得中です。少し待ってからもう一度聞いてね。`;
    }

    const formatter =
      this.stringPressureLevel[this.currentPressureLevel] ??
      this.stringPressureLevel['0'];

    return formatter(this.currentLocationName, this.currentPressure);
  }

  @bindThis
  private async generateForecastImageFile(): Promise<DriveFile | undefined> {
    if (!this.latestWeatherData) return undefined;

    const image = renderKiatsuImage(this.latestWeatherData);

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

    message.reply(this.buildPressureMessage(), {
      immediate: true,
      file,
    });

    return true;
  }
}
