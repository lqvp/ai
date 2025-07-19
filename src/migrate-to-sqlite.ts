#!/usr/bin/env node

import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import loki from 'lokijs';
import chalk from 'chalk';
import config from './config.js';

/**
 * Standalone migration script from memory.json to SQLite
 */
class MigrationTool {
  private sqliteDb!: Database.Database;
  private log: (message: string) => void;

  constructor(log: (message: string) => void = console.log) {
    this.log = log;
  }

  public async migrate() {
    let memoryDir = '.';
    if (config.memoryDir) {
      memoryDir = config.memoryDir;
    }

    const memoryJsonPath = path.resolve(memoryDir, 'memory.json');
    const sqlitePath = path.resolve(memoryDir, 'ai.db');
    const migrationMarker = sqlitePath + '.migrated';

    // Check if memory.json exists
    if (!fs.existsSync(memoryJsonPath)) {
      this.log(chalk.yellow('No memory.json found. Nothing to migrate.'));
      return;
    }

    // Check if already migrated
    if (fs.existsSync(migrationMarker)) {
      this.log(chalk.yellow('Migration already completed.'));
      return;
    }

    this.log(chalk.blue('Starting migration from memory.json to SQLite...'));

    try {
      // Create SQLite database
      this.sqliteDb = new Database(sqlitePath);
      this.sqliteDb.pragma('journal_mode = WAL');
      this.sqliteDb.pragma('synchronous = NORMAL');

      // Initialize database schema
      this.initializeDatabase();

      // Load and parse memory.json
      const memoryData = fs.readFileSync(memoryJsonPath, 'utf8');
      const lokiData = JSON.parse(memoryData);

      // Migrate each collection
      if (lokiData.collections) {
        for (const collection of lokiData.collections) {
          this.log(`Migrating collection: ${collection.name}`);
          this.migrateCollection(collection);
        }
      }

      // Create migration marker
      fs.writeFileSync(migrationMarker, new Date().toISOString());

      this.log(chalk.green('Migration completed successfully!'));
      this.log(chalk.yellow(`Original memory.json preserved at: ${memoryJsonPath}`));
      this.log(chalk.yellow('You can safely delete it after verifying the migration.'));

      // Close database
      this.sqliteDb.close();
    } catch (error: any) {
      this.log(chalk.red(`Migration failed: ${error.message}`));
      throw error;
    }
  }

  private initializeDatabase() {
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

  private migrateCollection(collection: any) {
    if (!collection.data || !Array.isArray(collection.data)) {
      this.log(chalk.yellow(`  Collection ${collection.name} has no data`));
      return;
    }

    const stmt = this.sqliteDb.prepare(
      'INSERT OR REPLACE INTO collections (collection_name, document_id, data, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    );

    let count = 0;
    for (const doc of collection.data) {
      // Clean up LokiJS metadata
      const cleanDoc = { ...doc };
      delete cleanDoc.$loki;
      delete cleanDoc.meta;

      // Determine document ID
      const documentId = cleanDoc.id || cleanDoc._id || cleanDoc.userId || count;

      // Get timestamps from LokiJS metadata if available
      const createdAt = doc.meta?.created || Date.now();
      const updatedAt = doc.meta?.updated || Date.now();

      stmt.run(
        collection.name,
        String(documentId),
        JSON.stringify(cleanDoc),
        createdAt,
        updatedAt
      );

      count++;
    }

    this.log(chalk.green(`  Migrated ${count} documents`));
  }
}

// Run migration if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  const migrationTool = new MigrationTool();
  migrationTool.migrate().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}

export default MigrationTool;