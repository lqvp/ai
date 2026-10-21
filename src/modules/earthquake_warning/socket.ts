import WebSocket, { type RawData } from 'ws';

export type HeartbeatOptions = {
  intervalMs: number;
  timeoutMs: number;
  /** 直近に通信があったかどうか */
  isAlive: () => boolean;
  onTimeout: () => void;
};

export type ManagedSocketOptions = {
  url: string;
  /** ログ接頭辞（例: `P2PQuake`） */
  label: string;
  log: (message: string) => void;
  userAgent?: string;
  maxReconnectAttempts: number;
  reconnectDelay: number;
  maxReconnectDelay: number;
  onOpen: (socket: ManagedSocket) => void;
  onMessage: (data: RawData) => void;
  onError: (error: Error) => void;
  onClose: (code: number, reason: string) => void;
  heartbeat?: HeartbeatOptions;
};

/**
 * 再接続・ハートビート付きの WebSocket クライアント。
 *
 * もとは earthquake_warning に Wolfx 用と P2PQuake 用の
 * ほぼ同じ接続管理コードが2份あった。
 */
export class ManagedSocket {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private disposed = false;

  constructor(private readonly options: ManagedSocketOptions) {}

  public get raw(): WebSocket | null {
    return this.ws;
  }

  public isOpen(): boolean {
    return this.ws != null && this.ws.readyState === WebSocket.OPEN;
  }

  public connect(): void {
    if (this.disposed) return;
    // 接続済み・接続中なら二重に張らない
    if (
      this.ws != null &&
      (this.ws.readyState === WebSocket.CONNECTING ||
        this.ws.readyState === WebSocket.OPEN)
    ) {
      return;
    }

    try {
      this.options.log(`${this.options.label} WebSocketに接続しています...`);

      this.ws = new WebSocket(this.options.url, [], {
        ...(this.options.userAgent
          ? { headers: { 'User-Agent': this.options.userAgent } }
          : {}),
      });

      this.ws.on('open', () => this.guard(() => this.handleOpen()));
      this.ws.on('message', (data) =>
        this.guard(() => this.handleMessage(data))
      );
      this.ws.on('error', (error) => this.guard(() => this.handleError(error)));
      this.ws.on('close', (code, reason) =>
        this.guard(() => this.handleClose(code, reason.toString()))
      );

      if (this.options.heartbeat) {
        this.startHeartbeat(this.options.heartbeat);
      }
    } catch (error) {
      this.options.log(`${this.options.label} WebSocket接続エラー: ${error}`);
      this.scheduleReconnect();
    }
  }

  public send(payload: string): void {
    if (this.isOpen()) {
      this.ws?.send(payload);
    }
  }

  public close(): void {
    this.disposed = true;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    if (this.ws) {
      try {
        this.ws.terminate();
      } catch (error) {
        this.options.log(`${this.options.label} 接続終了エラー: ${error}`);
      } finally {
        this.ws = null;
      }
    }
  }

  /** 状態を変えずに接続だけ張り直す（ハートビート復帰など） */
  public reconnectNow(): void {
    this.disposeSocket();
    this.connect();
  }

  private disposeSocket(): void {
    if (this.ws) {
      try {
        this.ws.terminate();
      } catch {
        // 切断済みでも続行
      } finally {
        this.ws = null;
      }
    }
  }

  private handleOpen(): void {
    this.reconnectAttempts = 0;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.options.onOpen(this);
  }

  private handleMessage(data: RawData): void {
    if (!data) {
      this.options.log(`${this.options.label}: 空のメッセージを受信しました`);
      return;
    }
    this.options.onMessage(data);
  }

  private handleError(error: Error): void {
    this.options.onError(error);
    this.scheduleReconnect();
  }

  private handleClose(code: number, reason: string): void {
    this.options.onClose(code, reason);
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.disposed) return;
    if (this.reconnectTimer) return;

    if (this.reconnectAttempts >= this.options.maxReconnectAttempts) {
      this.options.log(
        `${this.options.label}: 最大再接続試行回数を超えました。再接続を停止します。`
      );
      return;
    }

    this.reconnectAttempts++;

    const baseDelay =
      this.options.reconnectDelay * Math.pow(1.5, this.reconnectAttempts - 1);
    const jitter = 0.1 * baseDelay * (Math.random() - 0.5);
    const delay = Math.min(baseDelay + jitter, this.options.maxReconnectDelay);

    this.options.log(
      `${Math.round(delay)}ms後に${this.options.label}へ再接続を試みます (試行: ${
        this.reconnectAttempts
      }/${this.options.maxReconnectAttempts})`
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startHeartbeat(heartbeat: HeartbeatOptions): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);

    this.heartbeatTimer = setInterval(() => {
      if (!heartbeat.isAlive()) {
        this.options.log('ハートビートのタイムアウト。再接続します。');
        heartbeat.onTimeout();
      }
    }, heartbeat.intervalMs);
  }

  /**
   * イベントハンドラの例外でプロセスを落とさない。
   */
  private guard(action: () => void): void {
    try {
      action();
    } catch (error) {
      this.options.log(
        `${this.options.label} イベントハンドラでエラーが発生しました: ${error}`
      );
      this.disposeSocket();
      this.scheduleReconnect();
    }
  }
}
