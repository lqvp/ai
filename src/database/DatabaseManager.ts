import chalk from 'chalk';
import * as fs from 'fs';
import loki from 'lokijs';
import path from 'path';
import type { Meta } from '@/ai.js';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import type { FriendDoc } from '@/friend.js';
import { CURRENT_SCHEMA_VERSION, migrate } from './migrations.js';
import {
  type ContextDoc,
  ContextRepository,
  FriendRepository,
  type ModuleDataDoc,
  ModuleDataRepository,
  type Repositories,
  type TimerDoc,
  TimerRepository,
} from './repositories.js';

/**
 * データベース管理クラス
 * LokiJSデータベースの初期化と管理を担当
 */
export default class DatabaseManager {
  public db!: loki;
  public meta!: loki.Collection<Meta>;
  public contexts!: loki.Collection<ContextDoc>;
  public timers!: loki.Collection<TimerDoc>;
  public friends!: loki.Collection<FriendDoc>;
  public moduleData!: loki.Collection<ModuleDataDoc>;
  public repositories!: Repositories;
  private log: (message: string) => void;

  constructor(
    onReady: () => void,
    onError: (err: any) => void,
    log: (message: string) => void = console.log
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
        `Failed to create memory directory: ${e.message}`
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
      // 1秒ごとだと memory.json 全体を頻繁に書き出すため 5 秒に延ばす
      autosaveInterval: 5000,
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
    onError: (err: any) => void
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
        autosaveInterval: 5000,
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
      indices: ['key', 'noteId', 'userId', 'module'],
    });
    this.timers = this.getCollection('timers', {
      indices: ['module', 'insertedAt'],
    });
    this.friends = this.getCollection('friends', {
      indices: ['userId'],
    });
    this.moduleData = this.getCollection('moduleData', {
      indices: ['module'],
    });

    this.repositories = {
      friends: new FriendRepository(this.friends),
      contexts: new ContextRepository(this.contexts),
      timers: new TimerRepository(this.timers),
      moduleData: new ModuleDataRepository(this.moduleData),
    };

    // メタデータが存在することを保証する
    const meta = this.getMeta();

    // スキーマのマイグレーション（重複の掃除など）。必要なときだけ走る。
    try {
      const applied = migrate({
        meta,
        collections: {
          contexts: this.contexts,
          friends: this.friends,
          moduleData: this.moduleData,
        },
        log: this.log,
      });
      if (applied) {
        this.log(
          chalk.blue(`Migrated the memory to schema v${CURRENT_SCHEMA_VERSION}`)
        );
        this.setMeta(meta);
      }
    } catch (err) {
      this.log(chalk.red(`Failed to migrate the memory: ${String(err)}`));
    }
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
    opts?: any
  ): loki.Collection<T> {
    let collection = this.db.getCollection<T>(name);

    if (collection === null) {
      collection = this.db.addCollection<T>(name, opts);
    }

    return collection;
  }

  /**
   * データベースを保存して閉じる。
   */
  @bindThis
  public close(): void {
    try {
      this.db.saveDatabase();
    } catch (err) {
      this.log(chalk.red(`Failed to save the memory: ${String(err)}`));
    }

    try {
      this.db.close();
    } catch (err) {
      this.log(chalk.red(`Failed to close the memory: ${String(err)}`));
    }
  }
}
