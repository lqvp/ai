import Database from 'better-sqlite3';
import { bindThis } from '@/decorators.js';
import config from '@/config.js';
import chalk from 'chalk';
import type { Meta } from '@/ai.js';
import type { FriendDoc } from '@/friend.js';
import * as fs from 'fs';
import path from 'path';
import loki from 'lokijs';

// SQLiteコレクションのインターフェース（LokiJSのCollectionインターフェースを模倣）
interface SQLiteCollection<T extends object = any> {
  find(query?: any): T[];
  findOne(query?: any): T | null;
  insertOne(doc: T): T;
  insert(docs: T[]): T[];
  update(doc: T): void;
  updateWhere(filterFunction: (obj: T) => boolean, updateFunction: (obj: T) => T): void;
  remove(doc: T): void;
  removeWhere(query: any): void;
  clear(): void;
  count(): number;
  chain(): any;
  data: T[];
  name: string;
}

// LokiJSのメタデータを模倣
interface LokiObj {
  $loki?: number;
  meta?: {
    created: number;
    revision: number;
    updated: number;
    version: number;
  };
}

/**
 * データベース管理クラス
 * SQLiteデータベースの初期化と管理を担当（LokiJS互換インターフェース）
 */
export default class DatabaseManager {
  private sqliteDb!: Database.Database;
  public db!: any; // LokiJS互換のためのダミーオブジェクト
  public meta!: SQLiteCollection<Meta>;
  public contexts!: SQLiteCollection<{
    isChat: boolean;
    noteId?: string;
    userId?: string;
    module: string;
    key: string | null;
    data?: any;
  }>;
  public timers!: SQLiteCollection<{
    id: string;
    module: string;
    insertedAt: number;
    delay: number;
    data?: any;
  }>;
  public friends!: SQLiteCollection<FriendDoc>;
  public moduleData!: SQLiteCollection<any>;
  private collections: Map<string, SQLiteCollection<any>> = new Map();
  private log: (message: string) => void;
  private dbPath: string;

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
      return;
    }

    this.dbPath =
      process.env.NODE_ENV === 'test'
        ? path.resolve(memoryDir, 'test.ai.db')
        : path.resolve(memoryDir, 'ai.db');

    const memoryJsonPath =
      process.env.NODE_ENV === 'test'
        ? path.resolve(memoryDir, 'test.memory.json')
        : path.resolve(memoryDir, 'memory.json');

    this.log(`Loading the database from ${this.dbPath}...`);

    try {
      // SQLiteデータベースを開く
      this.sqliteDb = new Database(this.dbPath);
      this.sqliteDb.pragma('journal_mode = WAL');
      this.sqliteDb.pragma('synchronous = NORMAL');

      // memory.jsonが存在する場合はマイグレーションを実行
      if (fs.existsSync(memoryJsonPath) && !fs.existsSync(this.dbPath + '.migrated')) {
        this.log(chalk.yellow('Found memory.json, starting migration...'));
        this.migrateFromLokiJS(memoryJsonPath);
        // マイグレーション完了マーカーを作成
        fs.writeFileSync(this.dbPath + '.migrated', '');
      }

      this.initializeDatabase();
      this.initializeCollections();
      
      // LokiJS互換のダミーオブジェクトを作成
      this.db = {
        collections: Array.from(this.collections.values()),
        getCollection: this.getCollection.bind(this),
        addCollection: this.getCollection.bind(this),
      };

      this.log(chalk.green('The database loaded successfully'));
      onReady();
    } catch (e: any) {
      this.log(chalk.red(`Failed to load the database: ${e}`));
      this.attemptRecovery(onReady, onError);
    }
  }

  /**
   * LokiJSからSQLiteへのマイグレーション
   */
  @bindThis
  private migrateFromLokiJS(memoryJsonPath: string) {
    try {
      const lokiDb = new loki(memoryJsonPath);
      const memoryData = fs.readFileSync(memoryJsonPath, 'utf8');
      const lokiData = JSON.parse(memoryData);

      // 各コレクションをマイグレート
      if (lokiData.collections) {
        for (const collection of lokiData.collections) {
          this.log(`Migrating collection: ${collection.name}`);
          const sqliteCollection = this.getCollection(collection.name, collection.options);
          
          if (collection.data && Array.isArray(collection.data)) {
            for (const doc of collection.data) {
              // LokiJSのメタデータを削除
              const cleanDoc = { ...doc };
              delete cleanDoc.$loki;
              delete cleanDoc.meta;
              sqliteCollection.insertOne(cleanDoc);
            }
          }
        }
      }

      this.log(chalk.green('Migration completed successfully'));
    } catch (e: any) {
      this.log(chalk.red(`Migration failed: ${e.message}`));
      throw e;
    }
  }

  /**
   * SQLiteデータベースの初期化
   */
  @bindThis
  private initializeDatabase() {
    // 汎用的なドキュメントストアテーブルを作成
    this.sqliteDb.exec(`
      CREATE TABLE IF NOT EXISTS collections (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collection_name TEXT NOT NULL,
        document_id TEXT NOT NULL,
        data TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        updated_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
        UNIQUE(collection_name, document_id)
      );
      
      CREATE INDEX IF NOT EXISTS idx_collection_name ON collections(collection_name);
      CREATE INDEX IF NOT EXISTS idx_document_id ON collections(document_id);
    `);
  }

  /**
   * データベースのリカバリーを試みる
   */
  @bindThis
  private attemptRecovery(
    onReady: () => void,
    onError: (err: any) => void
  ) {
    try {
      this.log(chalk.yellow('Attempting to recover database...'));

      const backupFile = `${this.dbPath}.bak.${Date.now()}`;
      if (fs.existsSync(this.dbPath)) {
        fs.copyFileSync(this.dbPath, backupFile);
        this.log(chalk.yellow(`Created backup at: ${backupFile}`));
        fs.unlinkSync(this.dbPath);
      }

      this.sqliteDb = new Database(this.dbPath);
      this.sqliteDb.pragma('journal_mode = WAL');
      this.sqliteDb.pragma('synchronous = NORMAL');

      this.initializeDatabase();
      this.initializeCollections();
      
      this.db = {
        collections: Array.from(this.collections.values()),
        getCollection: this.getCollection.bind(this),
        addCollection: this.getCollection.bind(this),
      };

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
   * コレクションを取得、存在しない場合は作成（LokiJS互換インターフェース）
   */
  @bindThis
  public getCollection<T extends object = any>(
    name: string,
    opts?: any
  ): SQLiteCollection<T> {
    if (this.collections.has(name)) {
      return this.collections.get(name) as SQLiteCollection<T>;
    }

    const collection = new SQLiteCollectionImpl<T>(this.sqliteDb, name, opts);
    this.collections.set(name, collection);
    return collection;
  }

  /**
   * データベースを最適化（VACUUM）
   */
  @bindThis
  public vacuum() {
    try {
      this.sqliteDb.exec('VACUUM');
      this.log('Database vacuumed successfully');
    } catch (e: any) {
      this.log(chalk.red(`Failed to vacuum database: ${e.message}`));
    }
  }

  /**
   * データベースのバックアップを作成
   */
  @bindThis
  public backup(backupPath?: string) {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupFile = backupPath || `${this.dbPath}.backup.${timestamp}`;
    
    try {
      this.sqliteDb.backup(backupFile);
      this.log(chalk.green(`Database backed up to: ${backupFile}`));
      return backupFile;
    } catch (e: any) {
      this.log(chalk.red(`Failed to backup database: ${e.message}`));
      throw e;
    }
  }

  /**
   * データベースの統計情報を取得
   */
  @bindThis
  public getStats() {
    const collections = Array.from(this.collections.keys());
    const stats: any = {
      collections: {},
      total: {
        collections: collections.length,
        documents: 0,
        sizeBytes: 0
      }
    };

    // 各コレクションの統計
    for (const name of collections) {
      const collection = this.collections.get(name)!;
      const count = collection.count();
      stats.collections[name] = {
        documents: count
      };
      stats.total.documents += count;
    }

    // データベースファイルサイズ
    if (fs.existsSync(this.dbPath)) {
      stats.total.sizeBytes = fs.statSync(this.dbPath).size;
    }

    return stats;
  }

  /**
   * データベースを閉じる
   */
  @bindThis
  public close() {
    if (this.sqliteDb) {
      this.sqliteDb.close();
      this.log('Database closed');
    }
  }
}

/**
 * SQLiteベースのコレクション実装（LokiJS互換インターフェース）
 */
class SQLiteCollectionImpl<T extends object = any> implements SQLiteCollection<T> {
  private db: Database.Database;
  public name: string;
  private opts: any;
  private idCounter: number = 0;
  
  // プリペアドステートメントのキャッシュ
  private stmtCache: Map<string, Database.Statement> = new Map();

  constructor(db: Database.Database, name: string, opts?: any) {
    this.db = db;
    this.name = name;
    this.opts = opts || {};
    
    // IDカウンターを初期化
    const maxId = this.db.prepare(
      'SELECT MAX(CAST(json_extract(data, "$.id") AS INTEGER)) as max_id FROM collections WHERE collection_name = ?'
    ).get(name) as any;
    this.idCounter = (maxId?.max_id || 0) + 1;
    
    // よく使うステートメントを事前に準備
    this.prepareStatements();
  }

  private prepareStatements() {
    this.stmtCache.set('find', this.db.prepare(
      'SELECT data FROM collections WHERE collection_name = ? ORDER BY created_at'
    ));
    
    this.stmtCache.set('insert', this.db.prepare(
      'INSERT OR REPLACE INTO collections (collection_name, document_id, data, updated_at) VALUES (?, ?, ?, ?)'
    ));
    
    this.stmtCache.set('update', this.db.prepare(
      'UPDATE collections SET data = ?, updated_at = ? WHERE collection_name = ? AND document_id = ?'
    ));
    
    this.stmtCache.set('delete', this.db.prepare(
      'DELETE FROM collections WHERE collection_name = ? AND document_id = ?'
    ));
    
    this.stmtCache.set('clear', this.db.prepare(
      'DELETE FROM collections WHERE collection_name = ?'
    ));
    
    this.stmtCache.set('count', this.db.prepare(
      'SELECT COUNT(*) as count FROM collections WHERE collection_name = ?'
    ));
  }

  get data(): T[] {
    return this.find();
  }

  find(query?: any): T[] {
    const stmt = this.stmtCache.get('find')!;
    const rows = stmt.all(this.name) as any[];
    
    let results = rows.map(row => JSON.parse(row.data) as T);
    
    if (query && Object.keys(query).length > 0) {
      results = results.filter(doc => this.matchesQuery(doc, query));
    }
    
    return results;
  }

  findOne(query?: any): T | null {
    const results = this.find(query);
    return results.length > 0 ? results[0] : null;
  }

  insertOne(doc: T): T {
    const docWithId = { ...doc } as any;
    if (!docWithId.id && !docWithId._id) {
      docWithId.id = this.idCounter++;
    }
    
    const documentId = docWithId.id || docWithId._id || this.idCounter++;
    
    const stmt = this.stmtCache.get('insert')!;
    
    stmt.run(this.name, String(documentId), JSON.stringify(docWithId), Date.now());
    
    return docWithId;
  }

  insert(docs: T[]): T[] {
    const insertStmt = this.stmtCache.get('insert')!;
    
    const insertMany = this.db.transaction((documents: T[]) => {
      const results: T[] = [];
      for (const doc of documents) {
        const docWithId = { ...doc } as any;
        if (!docWithId.id && !docWithId._id) {
          docWithId.id = this.idCounter++;
        }
        
        const documentId = docWithId.id || docWithId._id || this.idCounter++;
        insertStmt.run(this.name, String(documentId), JSON.stringify(docWithId), Date.now());
        results.push(docWithId);
      }
      return results;
    });
    
    return insertMany(docs);
  }

  update(doc: T): void {
    const docAny = doc as any;
    const documentId = docAny.id || docAny._id;
    
    if (!documentId) {
      throw new Error('Document must have an id or _id field');
    }
    
    const stmt = this.stmtCache.get('update')!;
    
    stmt.run(JSON.stringify(doc), Date.now(), this.name, String(documentId));
  }

  updateWhere(filterFunction: (obj: T) => boolean, updateFunction: (obj: T) => T): void {
    const docs = this.find();
    const toUpdate = docs.filter(filterFunction);
    
    for (const doc of toUpdate) {
      const updated = updateFunction(doc);
      this.update(updated);
    }
  }

  remove(doc: T): void {
    const docAny = doc as any;
    const documentId = docAny.id || docAny._id;
    
    if (!documentId) {
      throw new Error('Document must have an id or _id field');
    }
    
    const stmt = this.stmtCache.get('delete')!;
    
    stmt.run(this.name, String(documentId));
  }

  removeWhere(query: any): void {
    const docs = this.find(query);
    for (const doc of docs) {
      this.remove(doc);
    }
  }

  clear(): void {
    const stmt = this.stmtCache.get('clear')!;
    stmt.run(this.name);
  }

  count(): number {
    const stmt = this.stmtCache.get('count')!;
    const result = stmt.get(this.name) as any;
    return result.count;
  }

  chain(): any {
    // LokiJS互換のためのチェーンAPIスタブ
    const results = this.find();
    return {
      find: (query?: any) => {
        const filtered = query ? results.filter(doc => this.matchesQuery(doc, query)) : results;
        return {
          simplesort: (field: string, desc?: boolean) => {
            const sorted = [...filtered].sort((a: any, b: any) => {
              const aVal = a[field];
              const bVal = b[field];
              if (aVal < bVal) return desc ? 1 : -1;
              if (aVal > bVal) return desc ? -1 : 1;
              return 0;
            });
            return {
              limit: (n: number) => ({
                data: () => sorted.slice(0, n)
              }),
              data: () => sorted
            };
          },
          limit: (n: number) => ({
            data: () => filtered.slice(0, n)
          }),
          data: () => filtered
        };
      },
      simplesort: (field: string, desc?: boolean) => {
        const sorted = [...results].sort((a: any, b: any) => {
          const aVal = a[field];
          const bVal = b[field];
          if (aVal < bVal) return desc ? 1 : -1;
          if (aVal > bVal) return desc ? -1 : 1;
          return 0;
        });
        return {
          limit: (n: number) => ({
            data: () => sorted.slice(0, n)
          }),
          data: () => sorted
        };
      },
      data: () => results
    };
  }

  private matchesQuery(doc: any, query: any): boolean {
    for (const key in query) {
      if (query[key] !== doc[key]) {
        return false;
      }
    }
    return true;
  }
}
