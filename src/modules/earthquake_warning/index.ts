import type WebSocket from 'ws';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import {
  generateEarthquakeMessage as formatEarthquakeMessage,
  generateTsunamiMessage,
} from './format.js';
import { ManagedSocket } from './socket.js';
import type {
  EarthquakeEvent,
  HeartbeatData,
  WolfxEarthquakeData,
} from './types.js';
import {
  shouldReportEarthquake,
  validateEarthquakeData,
  validateTsunamiData,
} from './validation.js';

export default class extends Module {
  public readonly name = 'earthquake_warning';

  private readonly WOLFX_WEBSOCKET_URL = 'wss://ws-api.wolfx.jp/jma_eew';
  private readonly P2P_WEBSOCKET_URL =
    config.earthquakeWarning?.p2pWebSocketUrl ?? 'wss://api.p2pquake.net/v2/ws';

  private wolfx: ManagedSocket | null = null;
  private p2p: ManagedSocket | null = null;
  private lastHeartbeat = 0;
  private activeEvents: Map<string, EarthquakeEvent> = new Map();
  private lastEarthquakeData: Map<string, WolfxEarthquakeData> = new Map();
  private processedTsunamiIds: Map<string, number> = new Map();
  // 接続後のデータ無視制御用
  private ignoreInitialData = true;
  private initialDataTimer: NodeJS.Timeout | null = null;
  private connectionId: string = ''; // 空文字列で初期化

  @bindThis
  public install() {
    if (!config.earthquakeWarning?.enabled) {
      this.log('地震警報モジュールは無効になっています。');
      return false;
    }
    this.log('地震警報モジュールを初期化しています...');
    this.connectionId = this.generateConnectionId();
    this.connectWolfx();
    this.connectP2P();
    return {};
  }

  private generateConnectionId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
  }

  private get socketOptions() {
    return {
      log: (message: string) => this.log(message),
      userAgent: config.userAgent?.websocket,
      maxReconnectAttempts:
        config.earthquakeWarning?.websocketReconnectMaxAttempts ?? 10,
      reconnectDelay: config.earthquakeWarning?.websocketReconnectDelay ?? 5000,
      maxReconnectDelay: config.earthquakeWarning?.maxReconnectDelay ?? 300000,
    };
  }

  @bindThis
  private connectWolfx(): void {
    const heartbeatTimeoutMs =
      config.earthquakeWarning?.heartbeatTimeoutMs ?? 120_000;
    const heartbeatIntervalMs =
      config.earthquakeWarning?.heartbeatIntervalMs ?? 60_000;

    this.lastHeartbeat = Date.now();
    this.wolfx = new ManagedSocket({
      ...this.socketOptions,
      url: this.WOLFX_WEBSOCKET_URL,
      label: 'Wolfx',
      onOpen: () => this.onWolfxOpen(),
      onMessage: (data) => this.onWolfxMessage(data),
      onError: (error) => this.onWolfxError(error),
      onClose: (code, reason) => this.onWolfxClose(code, reason),
      heartbeat: {
        intervalMs: heartbeatIntervalMs,
        timeoutMs: heartbeatTimeoutMs,
        isAlive: () => Date.now() - this.lastHeartbeat <= heartbeatTimeoutMs,
        onTimeout: () => this.wolfx?.reconnectNow(),
      },
    });
    this.wolfx.connect();
  }

  @bindThis
  private connectP2P(): void {
    this.p2p = new ManagedSocket({
      ...this.socketOptions,
      url: this.P2P_WEBSOCKET_URL,
      label: 'P2PQuake',
      onOpen: () => this.onP2POpen(),
      onMessage: (data) => this.onP2PMessage(data),
      onError: (error) => this.onP2PError(error),
      onClose: (code, reason) => this.onP2PClose(code, reason),
    });
    this.p2p?.connect();
  }

  @bindThis
  private onWolfxOpen(): void {
    this.log('WebSocket接続が確立されました');

    // 接続直後のデータを無視する
    this.ignoreInitialData = true;

    if (this.initialDataTimer) clearTimeout(this.initialDataTimer);
    this.initialDataTimer = setTimeout(() => {
      this.ignoreInitialData = false;
      this.initialDataTimer = null;
      this.log('初期データの無視期間が終了しました');
    }, 10000);
  }

  @bindThis
  private onWolfxMessage(data: WebSocket.RawData): void {
    try {
      let message: any;
      try {
        message = JSON.parse(data.toString());
      } catch (parseError) {
        this.log(
          `JSON解析エラー: ${parseError}、受信データ: ${data
            .toString()
            .slice(0, 100)}`
        );
        return;
      }

      if (message.type === 'heartbeat') {
        this.handleHeartbeat(message);
        return;
      }

      if (message.type === 'jma_eew') {
        this.handleEarthquakeData(message);
      }
    } catch (error) {
      this.log(`メッセージ処理エラー: ${error}`);
    }
  }

  @bindThis
  private onWolfxError(error: Error): void {
    if (error.message.includes('ECONNREFUSED')) {
      this.log(`接続が拒否されました: ${error.message}`);
    } else if (error.message.includes('ETIMEDOUT')) {
      this.log(`接続がタイムアウトしました: ${error.message}`);
    } else if (error.message.includes('ENOTFOUND')) {
      this.log(`ホストが見つかりません: ${error.message}`);
    } else {
      this.log(`WebSocketエラー: ${error.message}`);
    }
  }

  @bindThis
  private onWolfxClose(code: number, reason: string): void {
    this.log(`WebSocket接続が閉じられました: ${code} ${reason}`);
  }

  @bindThis
  private onP2POpen(): void {
    this.log('P2PQuake WebSocket接続が確立されました');
  }

  @bindThis
  private onP2PMessage(data: WebSocket.RawData): void {
    try {
      const parsed = JSON.parse(data.toString()) as unknown;

      if (!parsed || typeof parsed !== 'object') {
        return;
      }

      if (!('code' in parsed) || parsed.code !== 552) {
        return;
      }

      void this.handleTsunamiData(parsed);
    } catch (error) {
      this.log(`P2PQuakeメッセージ処理エラー: ${error}`);
    }
  }

  @bindThis
  private onP2PError(error: Error): void {
    this.log(`P2PQuake WebSocketエラー: ${error.message}`);
  }

  @bindThis
  private onP2PClose(code: number, reason: string): void {
    this.log(`P2PQuake WebSocket接続が閉じられました: ${code} ${reason}`);
  }

  @bindThis
  private handleHeartbeat(data: HeartbeatData): void {
    if (
      !data ||
      typeof data !== 'object' ||
      !('type' in data) ||
      data.type !== 'heartbeat'
    ) {
      this.log(
        `無効なハートビートデータを受信しました: ${JSON.stringify(data)}`
      );
      return;
    }

    this.lastHeartbeat = Date.now();
    this.wolfx?.send('ping');
  }

  protected onDispose(): void {
    if (this.initialDataTimer) {
      clearTimeout(this.initialDataTimer);
      this.initialDataTimer = null;
    }
    this.wolfx?.close();
    this.p2p?.close();
    this.wolfx = null;
    this.p2p = null;
  }

  @bindThis
  private async handleTsunamiData(data: unknown): Promise<void> {
    if (!validateTsunamiData(data)) {
      this.log('無効な津波データを受信しました。処理をスキップします。');
      return;
    }

    if (this.processedTsunamiIds.has(data.id)) {
      return;
    }

    this.processedTsunamiIds.set(data.id, Date.now());
    const message = generateTsunamiMessage(data);

    try {
      await this.ai.post({
        text: message,
      });

      this.log(`津波情報を送信しました: ${data.id}`);
      this.pruneProcessedTsunamiIds();
    } catch (error) {
      // 投稿失敗時は再受信で再試行できるようにする
      this.processedTsunamiIds.delete(data.id);
      this.log(`津波情報の送信エラー: ${error}`);
    }
  }

  @bindThis
  private pruneProcessedTsunamiIds(): void {
    if (this.processedTsunamiIds.size < 500) {
      return;
    }

    const expiryMs = 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const [id, processedAt] of this.processedTsunamiIds) {
      if (now - processedAt > expiryMs) {
        this.processedTsunamiIds.delete(id);
      }
    }
  }

  @bindThis
  private handleEarthquakeData(data: WolfxEarthquakeData): void {
    // データの基本検証
    if (!validateEarthquakeData(data, (m) => this.log(m))) {
      this.log('無効な地震データを受信しました。処理をスキップします。');
      return;
    }

    // 接続直後のデータは無視
    if (this.ignoreInitialData) {
      this.log(
        `接続直後のデータのため無視します: ${data.Hypocenter} M${data.Magunitude}`
      );
      return;
    }

    // トレーニングデータは無視
    if (data.isTraining) {
      this.log('トレーニングデータを受信しました（処理をスキップ）');
      return;
    }

    const eventId = data.EventID;
    const existingEvent = this.activeEvents.get(eventId);

    // イベントの処理
    if (!existingEvent) {
      // 新しい地震イベント
      if (
        !shouldReportEarthquake(data, {
          minIntensity: config.earthquakeWarning?.minIntensityThreshold ?? 3,
          minMagnitudeForWeak:
            config.earthquakeWarning?.minMagunitudeForWeak ?? 4.0,
        })
      ) {
        this.log(
          `報告基準を満たさない地震を検出: ${data.Hypocenter} M${data.Magunitude}`
        );
        return;
      }

      this.processNewEarthquake(data);
    } else if (data.isCancel && !existingEvent.isCancel) {
      // キャンセル情報
      this.processCancellation(data, existingEvent);
    } else if (data.isFinal && !existingEvent.isFinal) {
      // 最終報
      this.processFinalReport(data, existingEvent);
    } else {
      // 続報
      this.processUpdateReport(data, existingEvent);
    }
  }

  @bindThis
  private async processNewEarthquake(data: WolfxEarthquakeData): Promise<void> {
    // 既存のイベントをチェック
    const existingEvent = this.activeEvents.get(data.EventID);
    if (existingEvent && existingEvent.connectionId !== this.connectionId) {
      this.log(`他の接続で既に処理されているイベントです: ${data.EventID}`);
      return;
    }

    const message = this.generateEarthquakeMessage(data, true);
    const finalMessage = data.isFinal ? `【最終報】\n${message}` : message;

    try {
      const post = await this.ai.post({
        text: finalMessage,
      });

      this.activeEvents.set(data.EventID, {
        eventId: data.EventID,
        initialPostId: post.id,
        lastUpdate: Date.now(),
        reportCount: 1,
        isFinal: data.isFinal,
        isCancel: data.isCancel,
        connectionId: this.connectionId,
      });

      if (data.isFinal) {
        this.log(
          `新しい地震速報（最終報）を送信しました: ${data.Hypocenter} M${data.Magunitude}`
        );
        this.scheduleEventCleanup(data.EventID);
      } else {
        this.log(
          `新しい地震速報を送信しました: ${data.Hypocenter} M${data.Magunitude}`
        );
      }
    } catch (error) {
      this.log(`メッセージ送信エラー: ${error}`);
    }
  }

  @bindThis
  private async processUpdateReport(
    data: WolfxEarthquakeData,
    existingEvent: EarthquakeEvent
  ): Promise<void> {
    // 接続IDのチェック
    if (existingEvent.connectionId !== this.connectionId) {
      this.log(
        `他の接続で処理されているイベントの更新は無視します: ${data.EventID}`
      );
      return;
    }

    const reportNumber = existingEvent.reportCount + 1;
    const message = `【続報 #${reportNumber}】\n${this.generateEarthquakeMessage(
      data,
      false
    )}`;

    try {
      await this.ai.post({
        text: message,
        replyId: existingEvent.initialPostId,
      });

      this.activeEvents.set(data.EventID, {
        ...existingEvent,
        lastUpdate: Date.now(),
        reportCount: reportNumber,
      });

      this.log(
        `地震速報の続報を送信しました: ${data.Hypocenter} M${data.Magunitude}`
      );
    } catch (error) {
      this.log(`続報送信エラー: ${error}`);
    }
  }

  @bindThis
  private async processCancellation(
    data: WolfxEarthquakeData,
    existingEvent: EarthquakeEvent
  ): Promise<void> {
    if (existingEvent.connectionId !== this.connectionId) {
      this.log(
        `他の接続で処理されているイベントのキャンセルは無視します: ${data.EventID}`
      );
      return;
    }

    const message = `さっきの地震速報は取り消されました。実際の揺れはなかったようです。`;

    try {
      await this.ai.post({
        text: message,
        replyId: existingEvent.initialPostId,
      });

      this.activeEvents.set(data.EventID, {
        ...existingEvent,
        isCancel: true,
        lastUpdate: Date.now(),
      });

      this.log(`地震速報のキャンセルを送信しました: ${data.EventID}`);
      this.scheduleEventCleanup(data.EventID);
    } catch (error) {
      this.log(`キャンセル送信エラー: ${error}`);
    }
  }

  @bindThis
  private async processFinalReport(
    data: WolfxEarthquakeData,
    existingEvent: EarthquakeEvent
  ): Promise<void> {
    if (existingEvent.connectionId !== this.connectionId) {
      this.log(
        `他の接続で処理されているイベントの最終報は無視します: ${data.EventID}`
      );
      return;
    }

    if (existingEvent.isFinal) {
      this.log(`すでに最終報として処理済みのイベントです: ${data.EventID}`);
      return;
    }

    const message = `【最終報】\n${this.generateEarthquakeMessage(
      data,
      false
    )}`;

    try {
      await this.ai.post({
        text: message,
        replyId: existingEvent.initialPostId,
      });

      this.activeEvents.set(data.EventID, {
        ...existingEvent,
        isFinal: true,
        lastUpdate: Date.now(),
      });

      this.log(`地震速報の最終報を送信しました: ${data.EventID}`);
      this.scheduleEventCleanup(data.EventID);
    } catch (error) {
      this.log(`最終報送信エラー: ${error}`);
    }
  }

  /**
   * 整形処理を呼び出し、次回比較用のデータを保存する。
   */
  @bindThis
  private generateEarthquakeMessage(
    data: WolfxEarthquakeData,
    isInitial: boolean
  ): string {
    const previous = isInitial
      ? undefined
      : this.lastEarthquakeData.get(data.EventID);

    const message = formatEarthquakeMessage(data, isInitial, previous);

    this.lastEarthquakeData.set(data.EventID, { ...data });
    return message;
  }

  // ユーティリティ関数
  @bindThis
  private scheduleEventCleanup(eventId: string): void {
    this.later(3600000, () => {
      this.activeEvents.delete(eventId);
      this.lastEarthquakeData.delete(eventId);
    }); // 1時間後
  }
}
