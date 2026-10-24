import { EventEmitter } from 'events';
import _ReconnectingWebsocket from 'reconnecting-websocket';
import WebSocket from 'ws';
import { bindThis } from '@/decorators.js';
import config from './config.js';

const ReconnectingWebsocket =
  _ReconnectingWebsocket as unknown as (typeof _ReconnectingWebsocket)['default'];

/** 送信ペイロード。heartbeat は生の文字列、それ以外は { type, body } 形。 */
type OutgoingMessage = string | Record<string, unknown>;

const MAX_BUFFERED_MESSAGES = 1000;

/**
 * Misskey stream connection
 */
export default class Stream extends EventEmitter {
  private stream: InstanceType<typeof ReconnectingWebsocket>;
  private state: string;
  private buffer: OutgoingMessage[];
  private sharedConnectionPools: Pool[] = [];
  private sharedConnections: SharedConnection[] = [];
  private nonSharedConnections: NonSharedConnection[] = [];

  constructor() {
    super();

    this.state = 'initializing';
    this.buffer = [];

    // WebSocket接続オプションを設定
    const wsOptions = {
      WebSocket: WebSocket,
      // User-Agentを設定（WebSocket接続時にヘッダーとして送信）
      ...(config.userAgent?.websocket && {
        // reconnecting-websocketライブラリでは直接User-Agentを設定できないため、
        // WebSocketインスタンスをカスタマイズ
        WebSocket: class extends WebSocket {
          constructor(
            url: string,
            protocols?: string | string[],
            options?: WebSocket.ClientOptions
          ) {
            super(url, protocols, {
              ...options,
              headers: {
                ...options?.headers,
                'User-Agent':
                  config.userAgent?.websocket ||
                  'Misskey-Ai-Bot(https://github.com/lqvp/ai)',
              },
            });
          }
        },
      }),
    };

    this.stream = new ReconnectingWebsocket(
      `${config.wsUrl}/streaming?i=${config.i}`,
      [],
      wsOptions
    );
    this.stream.addEventListener('open', this.onOpen);
    this.stream.addEventListener('close', this.onClose);
    this.stream.addEventListener('message', this.onMessage);
  }

  @bindThis
  public useSharedConnection(channel: string): SharedConnection {
    let pool = this.sharedConnectionPools.find((p) => p.channel === channel);

    if (pool == null) {
      pool = new Pool(this, channel);
      this.sharedConnectionPools.push(pool);
    }

    const connection = new SharedConnection(this, channel, pool);
    this.sharedConnections.push(connection);
    return connection;
  }

  @bindThis
  public removeSharedConnection(connection: SharedConnection) {
    this.sharedConnections = this.sharedConnections.filter(
      (c) => c !== connection
    );
  }

  @bindThis
  public connectToChannel(
    channel: string,
    params?: Record<string, unknown>
  ): NonSharedConnection {
    const connection = new NonSharedConnection(this, channel, params);
    this.nonSharedConnections.push(connection);
    return connection;
  }

  @bindThis
  public disconnectToChannel(connection: NonSharedConnection) {
    this.nonSharedConnections = this.nonSharedConnections.filter(
      (c) => c !== connection
    );
  }

  /**
   * Callback of when open connection
   */
  @bindThis
  private onOpen() {
    const isReconnect = this.state == 'reconnecting';

    this.state = 'connected';
    this.emit('_connected_');

    // バッファーを処理
    const _buffer = [...this.buffer]; // Shallow copy
    this.buffer = []; // Clear buffer
    for (const data of _buffer) {
      this.send(data); // Resend each buffered messages
    }

    // チャンネル再接続
    if (isReconnect) {
      this.sharedConnectionPools.forEach((p) => {
        p.connect();
      });
      this.nonSharedConnections.forEach((c) => {
        c.connect();
      });
    }
  }

  /**
   * Callback of when close connection
   */
  @bindThis
  private onClose() {
    this.state = 'reconnecting';
    this.emit('_disconnected_');
  }

  /**
   * Callback of when received a message from connection
   */
  @bindThis
  private onMessage(message: MessageEvent) {
    let parsed: { type: string; body: unknown };
    try {
      parsed = JSON.parse(message.data);
    } catch {
      // 壊れたフレームでストリーム全体を止めない
      return;
    }

    const { type, body } = parsed;

    if (type == 'channel') {
      const {
        id,
        type: eventType,
        body: eventBody,
      } = body as { id: string; type: string; body: unknown };

      let connections: (Connection | undefined)[];

      connections = this.sharedConnections.filter((c) => c.id === id);

      if (connections.length === 0) {
        connections = [this.nonSharedConnections.find((c) => c.id === id)];
      }

      for (const c of connections.filter((c) => c != null)) {
        c!.emit(eventType, eventBody);
        c!.emit('*', { type: eventType, body: eventBody });
      }
    } else {
      this.emit(type, body);
      this.emit('*', { type, body });
    }
  }

  /**
   * Send a message to connection
   */
  @bindThis
  public send(typeOrPayload: OutgoingMessage, payload?: unknown) {
    const data =
      payload === undefined
        ? typeOrPayload
        : {
            type: typeOrPayload,
            body: payload,
          };

    // まだ接続が確立されていなかったらバッファリングして次に接続した時に送信する
    if (this.state != 'connected') {
      if (this.buffer.length >= MAX_BUFFERED_MESSAGES) {
        this.buffer.shift();
      }
      this.buffer.push(data);
      return;
    }

    this.stream.send(JSON.stringify(data));
  }

  @bindThis
  public heartbeat() {
    this.stream.send('h');
  }

  /**
   * Close this connection
   */
  @bindThis
  public close() {
    this.stream.removeEventListener('open', this.onOpen);
    this.stream.removeEventListener('message', this.onMessage);
    this.stream.removeEventListener('close', this.onClose);

    this.buffer = [];

    for (const connection of this.sharedConnections) {
      try {
        connection.dispose();
      } catch {
        // 切断済みでも停止処理は続行する
      }
    }
    this.sharedConnections = [];

    try {
      this.stream.close();
    } catch {
      // 未接続時の close は無視する
    }
  }
}

class Pool {
  public channel: string;
  public id: string;
  protected stream: Stream;
  private users = 0;
  private disposeTimerId: ReturnType<typeof setTimeout> | null = null;
  private isConnected = false;

  constructor(stream: Stream, channel: string) {
    this.channel = channel;
    this.stream = stream;

    this.id = Math.random().toString();
  }

  @bindThis
  public inc() {
    if (this.users === 0 && !this.isConnected) {
      this.connect();
    }

    this.users++;

    // タイマー解除
    if (this.disposeTimerId) {
      clearTimeout(this.disposeTimerId);
      this.disposeTimerId = null;
    }
  }

  @bindThis
  public dec() {
    this.users--;

    // そのコネクションの利用者が誰もいなくなったら
    if (this.users === 0) {
      // また直ぐに再利用される可能性があるので、一定時間待ち、
      // 新たな利用者が現れなければコネクションを切断する
      this.disposeTimerId = setTimeout(() => {
        this.disconnect();
      }, 3000);
    }
  }

  @bindThis
  public connect() {
    this.isConnected = true;
    this.stream.send('connect', {
      channel: this.channel,
      id: this.id,
    });
  }

  @bindThis
  private disconnect() {
    this.isConnected = false;
    this.disposeTimerId = null;
    this.stream.send('disconnect', { id: this.id });
  }
}

export abstract class Connection extends EventEmitter {
  public channel: string;
  protected stream: Stream;
  public abstract id: string;

  constructor(stream: Stream, channel: string) {
    super();

    this.stream = stream;
    this.channel = channel;
  }

  @bindThis
  public send(id: string, typeOrPayload: OutgoingMessage, payload?: unknown) {
    const type =
      payload === undefined
        ? (typeOrPayload as Record<string, unknown>).type
        : typeOrPayload;
    const body =
      payload === undefined
        ? (typeOrPayload as Record<string, unknown>).body
        : payload;

    this.stream.send('ch', {
      id: id,
      type: type,
      body: body,
    });
  }

  public abstract dispose(): void;
}

export class SharedConnection extends Connection {
  private pool: Pool;

  public get id(): string {
    return this.pool.id;
  }

  constructor(stream: Stream, channel: string, pool: Pool) {
    super(stream, channel);

    this.pool = pool;
    this.pool.inc();
  }

  @bindThis
  public send(typeOrPayload: OutgoingMessage, payload?: unknown) {
    super.send(this.pool.id, typeOrPayload, payload);
  }

  @bindThis
  public dispose() {
    this.pool.dec();
    this.removeAllListeners();
    this.stream.removeSharedConnection(this);
  }
}

export class NonSharedConnection extends Connection {
  public id: string;
  protected params: Record<string, unknown> | undefined;

  constructor(
    stream: Stream,
    channel: string,
    params?: Record<string, unknown>
  ) {
    super(stream, channel);

    this.params = params;
    this.id = Math.random().toString();

    this.connect();
  }

  @bindThis
  public connect() {
    this.stream.send('connect', {
      channel: this.channel,
      id: this.id,
      params: this.params,
    });
  }

  @bindThis
  public send(typeOrPayload: OutgoingMessage, payload?: unknown) {
    super.send(this.id, typeOrPayload, payload);
  }

  @bindThis
  public dispose() {
    this.removeAllListeners();
    this.stream.send('disconnect', { id: this.id });
    this.stream.disconnectToChannel(this);
  }
}
