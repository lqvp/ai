import Database from 'better-sqlite3';
import { bindThis } from '@/decorators.js';
import config from '@/config.js';
import chalk from 'chalk';
import type { Meta } from '@/ai.js';
import type { FriendDoc } from '@/friend.js';
import * as fs from 'fs';
import path from 'path';

// SQLiteコレクションラッパー（LokiJSのCollection APIを模倣）
export class SqliteCollection<T extends Record<string, any>> {
  private db: Database.Database;
  private tableName: string;
  private indices: string[];

  constructor(
    db: Database.Database,
    tableName: string,
    indices: string[] = [],
  ) {
    this.db = db;
    this.tableName = tableName;
    this.indices = indices;
    this.createTable();
  }

  private createTable() {
    // 汎用的なテーブル作成（JSONデータを格納）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        data TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
      )
    `);

    // インデックスの作成
    this.indices.forEach((index) => {
      this.db.exec(`
        CREATE INDEX IF NOT EXISTS idx_${this.tableName}_${index} 
        ON ${this.tableName}((json_extract(data, '$.${index}')))
      `);
    });
  }

  @bindThis
  public findOne(query: Partial<T>): T | null {
    let sql = `SELECT * FROM ${this.tableName}`;
    const conditions: string[] = [];
    const params: any[] = [];

    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined) {
        conditions.push(`json_extract(data, '$.${key}') = ?`);
        params.push(typeof value === 'object' ? JSON.stringify(value) : value);
      }
    });

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' LIMIT 1';

    const row = this.db.prepare(sql).get(...params) as any;
    if (!row) return null;

    const data = JSON.parse(row.data);
    // LokiJSのメタデータを追加
    data.$loki = row.id;
    data.meta = {
      created: row.created_at,
      revision: 0,
      updated: row.updated_at,
      version: 0,
    };
    return data;
  }

  @bindThis
  public find(query: Partial<T> = {}): T[] {
    let sql = `SELECT * FROM ${this.tableName}`;
    const conditions: string[] = [];
    const params: any[] = [];

    Object.entries(query).forEach(([key, value]) => {
      if (value !== undefined) {
        conditions.push(`json_extract(data, '$.${key}') = ?`);
        params.push(typeof value === 'object' ? JSON.stringify(value) : value);
      }
    });

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((row) => {
      const data = JSON.parse(row.data);
      data.$loki = row.id;
      data.meta = {
        created: row.created_at,
        revision: 0,
        updated: row.updated_at,
        version: 0,
      };
      return data;
    });
  }

  @bindThis
  public insertOne(doc: T): T {
    const data = { ...doc };
    // $lokiとmetaは除外
    delete (data as any).$loki;
    delete (data as any).meta;

    const stmt = this.db.prepare(`
      INSERT INTO ${this.tableName} (data) VALUES (?)
    `);
    const result = stmt.run(JSON.stringify(data));

    // 挿入されたデータを返す
    const inserted = { ...data };
    (inserted as any).$loki = result.lastInsertRowid;
    (inserted as any).meta = {
      created: Date.now(),
      revision: 0,
      updated: Date.now(),
      version: 0,
    };
    return inserted;
  }

  @bindThis
  public update(doc: T): void {
    const id = (doc as any).$loki;
    if (!id) throw new Error('Document must have $loki property');

    const data = { ...doc };
    delete (data as any).$loki;
    delete (data as any).meta;

    const stmt = this.db.prepare(`
      UPDATE ${this.tableName} 
      SET data = ?, updated_at = (strftime('%s', 'now') * 1000)
      WHERE id = ?
    `);
    stmt.run(JSON.stringify(data), id);
  }

  @bindThis
  public remove(doc: T | T[]): void {
    const docs = Array.isArray(doc) ? doc : [doc];
    const ids = docs.map((d) => (d as any).$loki).filter((id) => id != null);

    if (ids.length > 0) {
      const placeholders = ids.map(() => '?').join(',');
      const stmt = this.db.prepare(`
        DELETE FROM ${this.tableName} WHERE id IN (${placeholders})
      `);
      stmt.run(...ids);
    }
  }

  @bindThis
  public findAndRemove(query: Partial<T>): void {
    const docs = this.find(query);
    this.remove(docs);
  }
}

/**
 * SQLiteベースのデータベース管理クラス
 * LokiJSのAPIと互換性を保ちながらSQLiteを使用
 */
export default class SqliteDatabaseManager {
  private db!: Database.Database;
  public meta!: SqliteCollection<Meta>;
  public contexts!: SqliteCollection<{
    isChat: boolean;
    noteId?: string;
    userId?: string;
    module: string;
    key: string | null;
    data?: any;
  }>;
  public timers!: SqliteCollection<{
    id: string;
    module: string;
    insertedAt: number;
    delay: number;
    data?: any;
  }>;
  public friends!: SqliteCollection<FriendDoc>;
  public moduleData!: SqliteCollection<any>;
  private collections: Map<string, SqliteCollection<any>> = new Map();
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
      return;
    }

    const file =
      process.env.NODE_ENV === 'test'
        ? path.resolve(memoryDir, 'test.memory.db')
        : path.resolve(memoryDir, 'memory.db');

    this.log(`Loading the database from ${file}...`);

    try {
      this.db = new Database(file);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');

      this.initializeCollections();
      this.log(chalk.green('The database loaded successfully'));

      // 既存のmemory.jsonからのデータ移行をチェック
      this.checkAndMigrateFromJson(memoryDir);

      onReady();
    } catch (err) {
      this.log(chalk.red(`Failed to load the database: ${err}`));
      onError(err);
    }
  }

  /**
   * 既存のmemory.jsonからデータを移行
   */
  @bindThis
  private async checkAndMigrateFromJson(memoryDir: string) {
    const jsonFile = path.resolve(memoryDir, 'memory.json');
    const migrationFlag = path.resolve(memoryDir, '.migrated_to_sqlite');

    if (fs.existsSync(jsonFile) && !fs.existsSync(migrationFlag)) {
      this.log(
        chalk.yellow('Found existing memory.json. Starting migration...'),
      );

      try {
        const jsonData = fs.readFileSync(jsonFile, 'utf-8');
        const lokiData = JSON.parse(jsonData);

        // 各コレクションのデータを移行
        for (const collection of lokiData.collections || []) {
          const collectionName = collection.name;
          const sqliteCollection = this.getCollection(collectionName);

          for (const doc of collection.data || []) {
            // LokiJSのメタデータを除去してインサート
            const cleanDoc = { ...doc };
            delete cleanDoc.$loki;
            delete cleanDoc.meta;
            sqliteCollection.insertOne(cleanDoc);
          }

          this.log(
            chalk.green(
              `Migrated ${
                collection.data?.length || 0
              } records from ${collectionName}`,
            ),
          );
        }

        // 移行完了フラグを作成
        fs.writeFileSync(migrationFlag, new Date().toISOString());

        // 古いJSONファイルをバックアップ
        const backupFile = `${jsonFile}.bak.${Date.now()}`;
        fs.renameSync(jsonFile, backupFile);
        this.log(
          chalk.green(
            `Migration completed. Old file backed up to ${backupFile}`,
          ),
        );
      } catch (e: any) {
        this.log(chalk.red(`Migration failed: ${e.message}`));
      }
    }
  }

  /**
   * データベースコレクションを初期化
   */
  @bindThis
  private initializeCollections() {
    this.meta = new SqliteCollection(this.db, 'meta', []);
    this.contexts = new SqliteCollection(this.db, 'contexts', ['key']);
    this.timers = new SqliteCollection(this.db, 'timers', ['module']);
    this.friends = new SqliteCollection(this.db, 'friends', ['userId']);
    this.moduleData = new SqliteCollection(this.db, 'moduleData', ['module']);

    // 既存のコレクションをマップに追加
    this.collections.set('meta', this.meta);
    this.collections.set('contexts', this.contexts);
    this.collections.set('timers', this.timers);
    this.collections.set('friends', this.friends);
    this.collections.set('moduleData', this.moduleData);

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
  ): SqliteCollection<T> {
    let collection = this.collections.get(name);

    if (!collection) {
      const indices = opts?.indices || [];
      collection = new SqliteCollection<T>(this.db, name, indices);
      this.collections.set(name, collection);
    }

    return collection;
  }

  /**
   * データベースをクローズ
   */
  @bindThis
  public close(): void {
    if (this.db) {
      this.db.close();
    }
  }
}
