import loki from 'lokijs';
import { bindThis } from '@/decorators.js';
import config from '@/config.js';
import chalk from 'chalk';
import type { Meta } from '@/ai.js';
import type { FriendDoc } from '@/friend.js';
import * as fs from 'fs';
import path from 'path';
import SqliteDatabaseManager from './SqliteDatabaseManager.js';

// LokiJSがドキュメントに付加するメタデータ
interface LokiObj {
  $loki: number;
  meta: {
    created: number;
    revision: number;
    updated: number;
    version: number;
  };
}

/**
 * データベース管理クラス
 * LokiJSデータベースの初期化と管理を担当
 * 環境変数USE_SQLITE=trueでSQLiteを使用
 */
export default class DatabaseManager {
  // SQLiteを使用する場合は、SqliteDatabaseManagerのインスタンスを返す
  public static create(
    onReady: () => void,
    onError: (err: any) => void,
    log: (message: string) => void = console.log,
  ): DatabaseManager {
    if (process.env.USE_SQLITE === 'true' || config.useSqlite) {
      log(chalk.cyan('Using SQLite database'));
      return new SqliteDatabaseManager(onReady, onError, log) as any;
    } else {
      log(chalk.cyan('Using LokiJS database'));
      return new DatabaseManager(onReady, onError, log);
    }
  }

  public db!: loki;
  public meta!: loki.Collection<Meta>;
  public contexts!: loki.Collection<{
    isChat: boolean;
    noteId?: string;
    userId?: string;
    module: string;
    key: string | null;
    data?: any;
  }>;
  public timers!: loki.Collection<{
    id: string;
    module: string;
    insertedAt: number;
    delay: number;
    data?: any;
  }>;
  public friends!: loki.Collection<FriendDoc>;
  public moduleData!: loki.Collection<any>;
  private log: (message: string) => void;

  constructor(
    onReady: () => void,
    onError: (err: any) => void,
    log: (message: string) => void = console.log,
  ) {
    this.log = log;

    let memoryDir = '.';
    if (config.memoryDir) {
      memoryDir = config.memoryDir;
    }

    try {
      if (!fs.existsSync(memoryDir)) {
        fs.mkdirSync(memoryDir, { recursive: true });
        this.log(chalk.blue(`Created memory directory: ${memoryDir}`));
      }
    } catch (e: any) {
      const error = new Error(
        `Failed to create memory directory: ${e.message}`,
      );
      this.log(chalk.red(error.message));
      onError(error);
      return; // onErrorコールバックに処理を委譲
    }

    const file =
      process.env.NODE_ENV === 'test'
        ? path.resolve(memoryDir, 'test.memory.json')
        : path.resolve(memoryDir, 'memory.json');

    this.log(`Loading the memory from ${file}...`);

    this.db = new loki(file, {
      autoload: true,
      autosave: true,
      autosaveInterval: 1000,
      autoloadCallback: (err) => {
        if (err) {
          this.log(chalk.red(`Failed to load the memory: ${err}`));
          this.attemptRecovery(file, onReady, onError);
        } else {
          this.log(chalk.green('The memory loaded successfully'));
          this.initializeCollections();
          onReady();
        }
      },
    });
  }

  /**
   * データベースのリカバリーを試みる
   */
  @bindThis
  private attemptRecovery(
    file: string,
    onReady: () => void,
    onError: (err: any) => void,
  ) {
    try {
      this.log(chalk.yellow('Attempting to recover database...'));

      const backupFile = `${file}.bak.${Date.now()}`;
      if (fs.existsSync(file)) {
        fs.copyFileSync(file, backupFile);
        this.log(chalk.yellow(`Created backup at: ${backupFile}`));
        fs.unlinkSync(file);
      }

      this.db = new loki(file, {
        autoload: false,
        autosave: true,
        autosaveInterval: 1000,
      });

      this.initializeCollections();
      this.log(chalk.green('Database recovered successfully'));
      onReady();
    } catch (e: any) {
      const error = new Error(`Failed to recover database: ${e.message}`);
      this.log(chalk.red(error.message));
      onError(error);
    }
  }

  /**
   * データベースコレクションを初期化
   */
  @bindThis
  private initializeCollections() {
    this.meta = this.getCollection('meta', {});
    this.contexts = this.getCollection('contexts', {
      indices: ['key'],
    });
    this.timers = this.getCollection('timers', {
      indices: ['module'],
    });
    this.friends = this.getCollection('friends', {
      indices: ['userId'],
    });
    this.moduleData = this.getCollection('moduleData', {
      indices: ['module'],
    });

    // メタデータが存在することを保証する
    this.getMeta();
  }

  /**
   * メタデータを取得。なければ作成する。
   */
  @bindThis
  public getMeta(): Meta {
    const rec = this.meta.findOne({});

    if (rec) {
      return rec;
    } else {
      const initial: Meta = {
        lastWakingAt: Date.now(),
      };

      const inserted = this.meta.insertOne(initial);
      if (!inserted) {
        throw new Error('Failed to create initial meta document');
      }
      return inserted;
    }
  }

  /**
   * メタデータを更新
   */
  @bindThis
  public setMeta(meta: Partial<Meta>): void {
    const rec = this.getMeta();
    Object.assign(rec, meta);
    this.meta.update(rec);
  }

  /**
   * コレクションを取得、存在しない場合は作成
   */
  @bindThis
  public getCollection<T extends object = any>(
    name: string,
    opts?: any,
  ): loki.Collection<T> {
    let collection = this.db.getCollection<T>(name);

    if (collection === null) {
      collection = this.db.addCollection<T>(name, opts);
    }

    return collection;
  }
}
