import 藍, {
  type ContextHook,
  type HandlerResult,
  type InstallerResult,
  type MentionHook,
  type TimeoutCallback,
} from '@/ai.js';
import { bindThis } from '@/decorators.js';

export type ModuleDoc<TData> = {
  module: string;
  data: TData;
  $loki?: number;
  meta?: unknown;
};

/**
 * モジュールの基底クラス。
 *
 * - `getHooks()` が `install()` の戻り値とインスタンスメソッドをマージするため、
 *   `return { timeoutCallback: ... }` を書き忘れてもフックが登録される。
 * - `dispose()` / `every()` / `later()` でタイマーを確実に解放できる。
 * - `getData()` / `setData()` がモジュールごとの型を持つ。
 */
export default abstract class Module<
  TData extends Record<string, any> = Record<string, any>,
> {
  public abstract readonly name: string;

  protected ai!: 藍;
  private doc!: ModuleDoc<TData>;
  private readonly disposers = new Set<() => void>();
  private disposed = false;

  public init(ai: 藍): void {
    this.ai = ai;

    this.doc = this.ai.repos.moduleData.ensure(this.name) as ModuleDoc<TData>;
  }

  /**
   * モジュールを有効化する。無効の場合は `false` を返す。
   * フックは戻り値で返してもよいし、`mentionHook` などのメソッドとして
   * 定義してもよい（`getHooks()` が自動検出する）。
   */
  public abstract install(): InstallerResult | false;

  /**
   * `install()` の結果と、クラスに定義されたフックメソッドをマージする。
   */
  public getHooks(): InstallerResult {
    const result = this.install();
    if (result === false) return {};

    const hooks: InstallerResult = { ...result };
    const self = this as unknown as {
      mentionHook?: MentionHook;
      contextHook?: ContextHook;
      timeoutCallback?: TimeoutCallback;
    };

    if (hooks.mentionHook == null && typeof self.mentionHook === 'function') {
      hooks.mentionHook = self.mentionHook.bind(this);
    }
    if (hooks.contextHook == null && typeof self.contextHook === 'function') {
      hooks.contextHook = self.contextHook.bind(this);
    }
    if (
      hooks.timeoutCallback == null &&
      typeof self.timeoutCallback === 'function'
    ) {
      hooks.timeoutCallback = self.timeoutCallback.bind(this);
    }

    return hooks;
  }

  @bindThis
  protected log(msg: string): void {
    this.ai.log(`[${this.name}]: ${msg}`);
  }

  @bindThis
  protected logError(msg: string, err?: unknown): void {
    this.log(`${msg}${err === undefined ? '' : `: ${String(err)}`}`);
  }

  /**
   * コンテキストを生成し、ユーザーからの返信を待ち受けます
   * @param key コンテキストを識別するためのキー
   * @param isChat チャット上のコンテキストかどうか
   * @param id チャット上のコンテキストならばチャット相手のID、そうでないなら待ち受ける投稿のID
   * @param data コンテキストに保存するオプションのデータ
   */
  @bindThis
  protected subscribeReply(
    key: string | null,
    isChat: boolean,
    id: string,
    data?: any
  ): void {
    this.ai.subscribeReply(this, key, isChat, id, data);
  }

  /**
   * 返信の待ち受けを解除します
   * @param key コンテキストを識別するためのキー
   */
  @bindThis
  protected unsubscribeReply(key: string | null): void {
    this.ai.unsubscribeReply(this, key);
  }

  /**
   * 指定したミリ秒経過後に、タイムアウトコールバックを呼び出します。
   * このタイマーは記憶に永続化されるので、途中でプロセスを再起動しても有効です。
   */
  @bindThis
  public setTimeoutWithPersistence(delay: number, data?: unknown): void {
    this.ai.setTimeoutWithPersistence(this, delay, data);
  }

  /**
   * 一定間隔で実行する。前回の実行が終わるまでは次を実行しない。
   * `dispose()` で自動的に停止する。
   */
  @bindThis
  protected every(
    ms: number,
    task: () => unknown | Promise<unknown>,
    options: { immediate?: boolean } = {}
  ): void {
    if (this.disposed) return;

    let running = false;
    const run = async (): Promise<void> => {
      if (running || this.disposed) return;
      running = true;
      try {
        await task();
      } catch (err) {
        this.log(`interval task failed: ${String(err)}`);
      } finally {
        running = false;
      }
    };

    const id = setInterval(() => {
      void run();
    }, ms);
    this.disposers.add(() => clearInterval(id));

    if (options.immediate) {
      void run();
    }
  }

  /**
   * 一度だけ実行する。`dispose()` でキャンセルできる。
   */
  @bindThis
  protected later(ms: number, task: () => unknown | Promise<unknown>): void {
    if (this.disposed) return;

    let dispose: () => void = () => {};
    const id = setTimeout(() => {
      this.disposers.delete(dispose);
      Promise.resolve()
        .then(task)
        .catch((err) => {
          this.log(`timer task failed: ${String(err)}`);
        });
    }, ms);

    dispose = () => clearTimeout(id);
    this.disposers.add(dispose);
  }

  /**
   * モジュールが保持しているタイマーをすべて停止する。
   */
  @bindThis
  public dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    for (const dispose of this.disposers) {
      dispose();
    }
    this.disposers.clear();

    this.onDispose();
  }

  /**
   * サブクラスが追加の解放処理を行うためのフック。
   */
  protected onDispose(): void {
    // 既定では何もしない
  }

  @bindThis
  protected getData(): TData {
    return this.doc.data;
  }

  @bindThis
  protected setData(data: TData): void {
    this.doc.data = data;
    this.ai.repos.moduleData.save(this.doc);
  }
}

export type { HandlerResult };
