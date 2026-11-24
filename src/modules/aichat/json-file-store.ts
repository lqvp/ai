import { randomBytes } from 'node:crypto';
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

/**
 * JSON由来の値からプロトタイプ汚染の危険があるキーを再帰的に除去する。
 */
export function stripDangerousKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripDangerousKeys);
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      if (DANGEROUS_KEYS.has(key)) continue;
      out[key] = stripDangerousKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/**
 * JSON 文字列を安全にパースする（__proto__ 等の危険キーを除外）。
 */
export function safeJsonParse(raw: string): unknown {
  const parsed = JSON.parse(raw, (key, value) => {
    if (DANGEROUS_KEYS.has(key)) return undefined;
    return value;
  });
  return stripDangerousKeys(parsed);
}

export type JsonFileStoreOptions<T> = {
  filePath: string;
  createDefault: () => T;
  normalize: (raw: unknown) => T;
  /** true の場合、構文破損時はバックアップせずデフォルト値で再生成する */
  resetOnCorrupt?: boolean;
  log?: (message: string) => void;
  now?: () => number;
};

type FileSignature = {
  mtimeMs: number;
  size: number;
};

/**
 * memoryDir 配下の JSON ファイル用ストア。
 *
 * - ファイル単位の Promise キューで読み書き競合を直列化
 * - temp + rename によるアトミック書き込み
 * - mtime/size 監視により運用者の手動編集を取り込む
 * - 構文エラー時は .bak へ退避し、運用者の編集中ファイルを上書き破壊しない
 */
export class JsonFileStore<T> {
  private readonly filePath: string;
  private readonly createDefault: () => T;
  private readonly normalize: (raw: unknown) => T;
  private readonly resetOnCorrupt: boolean;
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  private state: T | null = null;
  private lastStat: FileSignature | null = null;
  private lastCorruptSig: string | null = null;
  private corruptedOnDisk = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(options: JsonFileStoreOptions<T>) {
    if (!options.filePath || options.filePath.includes('\0')) {
      throw new Error('Invalid filePath for JsonFileStore');
    }
    this.filePath = options.filePath;
    this.createDefault = options.createDefault;
    this.normalize = options.normalize;
    this.resetOnCorrupt = options.resetOnCorrupt ?? false;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
  }

  public get path(): string {
    return this.filePath;
  }

  public isCorrupted(): boolean {
    return this.corruptedOnDisk;
  }

  /**
   * 現在の正規化済み状態を読み込む（ディスクに外部変更があれば取り込む）。
   */
  public async load(): Promise<T> {
    return this.enqueue(async () => {
      await this.reloadIfChanged();
      return this.state!;
    });
  }

  /**
   * 最新状態を元に更新を適用し、アトミックに保存する。
   */
  public async update<R>(
    mutator: (current: T) => { next: T; result: R; write?: boolean }
  ): Promise<R> {
    return this.enqueue(async () => {
      await this.reloadIfChanged();
      const { next, result, write = true } = mutator(this.state!);
      const normalized = this.normalize(stripDangerousKeys(next));
      this.state = normalized;

      if (write) {
        if (this.corruptedOnDisk) {
          this.log(
            `破損状態の ${path.basename(this.filePath)} への上書きをスキップしました（手動修正待ち）`
          );
        } else {
          await this.atomicWrite(normalized);
        }
      }

      return result;
    });
  }

  private enqueue<R>(task: () => Promise<R>): Promise<R> {
    const run = this.queue.then(task, task);
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async reloadIfChanged(): Promise<void> {
    let st: Awaited<ReturnType<typeof stat>> | null = null;
    try {
      st = await stat(this.filePath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code === 'ENOENT') {
        if (this.state == null) {
          this.state = this.normalize(this.createDefault());
        }
        this.lastStat = null;
        this.corruptedOnDisk = false;
        this.lastCorruptSig = null;
        return;
      }
      this.log(`stat failed for ${this.filePath}: ${String(err)}`);
      if (this.state == null) {
        this.state = this.normalize(this.createDefault());
      }
      return;
    }

    if (!st.isFile()) {
      this.log(`${this.filePath} は通常ファイルではありません`);
      if (this.state == null) {
        this.state = this.normalize(this.createDefault());
      }
      return;
    }

    if (
      this.state != null &&
      this.lastStat != null &&
      this.lastStat.mtimeMs === st.mtimeMs &&
      this.lastStat.size === st.size
    ) {
      return;
    }

    let rawText: string;
    try {
      rawText = await readFile(this.filePath, 'utf8');
    } catch (err: unknown) {
      this.log(`readFile failed for ${this.filePath}: ${String(err)}`);
      if (this.state == null) {
        this.state = this.normalize(this.createDefault());
      }
      return;
    }

    try {
      const parsed = safeJsonParse(rawText);
      this.state = this.normalize(parsed);
      this.lastStat = { mtimeMs: st.mtimeMs, size: st.size };
      this.corruptedOnDisk = false;
      this.lastCorruptSig = null;
    } catch (err: unknown) {
      const sig = `${st.mtimeMs}:${st.size}`;
      this.log(
        `JSON parse failed for ${this.filePath}: ${err instanceof Error ? err.message : String(err)}`
      );

      if (this.resetOnCorrupt) {
        this.state = this.normalize(this.createDefault());
        this.corruptedOnDisk = false;
        this.lastCorruptSig = null;
        await this.atomicWrite(this.state);
        return;
      }

      this.corruptedOnDisk = true;
      this.lastStat = { mtimeMs: st.mtimeMs, size: st.size };
      if (this.lastCorruptSig !== sig) {
        this.lastCorruptSig = sig;
        const backupPath = `${this.filePath}.bak.${this.now()}`;
        try {
          await copyFile(this.filePath, backupPath);
          this.log(`破損ファイルのバックアップを作成しました: ${backupPath}`);
        } catch (copyErr: unknown) {
          this.log(`バックアップ作成に失敗しました: ${String(copyErr)}`);
        }
      }

      if (this.state == null) {
        this.state = this.normalize(this.createDefault());
      }
    }
  }

  private async atomicWrite(value: T): Promise<void> {
    const dir = path.dirname(this.filePath);
    await mkdir(dir, { recursive: true });
    const tmpPath = `${this.filePath}.tmp.${process.pid}.${randomBytes(4).toString('hex')}`;
    const body = `${JSON.stringify(value, null, 2)}\n`;

    try {
      await writeFile(tmpPath, body, 'utf8');
      await rename(tmpPath, this.filePath);
      const st = await stat(this.filePath);
      this.lastStat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err: unknown) {
      await unlink(tmpPath).catch(() => undefined);
      throw err;
    }
  }
}
