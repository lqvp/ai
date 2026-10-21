import type loki from 'lokijs';
import type { Meta } from '@/ai.js';
import type { ContextDoc, FriendDoc, ModuleDataDoc } from './repositories.js';

/**
 * `memory.json` のスキーマ版。
 *
 * - v1: 初版（暗黙。meta.schemaVersion なし）
 * - v2: friends.userId / moduleData.module / contexts の重複を一意化
 *
 * 形を変えるときはこの値を上げ、`migrate()` に変換を足す。
 */
export const CURRENT_SCHEMA_VERSION = 2;

export type MigrationContext = {
  meta: Meta;
  collections: {
    contexts: loki.Collection<ContextDoc>;
    friends: loki.Collection<FriendDoc>;
    moduleData: loki.Collection<ModuleDataDoc>;
  };
  log: (message: string) => void;
};

/**
 * 指定フィールドが重複しているドキュメントを1件だけ残す。
 * 残すのは最初に見つかったもの（＝古い方）。
 */
export function dedupeByField<T extends object>(
  collection: loki.Collection<T>,
  field: keyof T & string,
  log: (message: string) => void
): number {
  const seen = new Set<string>();
  const duplicates: T[] = [];

  for (const doc of collection.find()) {
    const key = String(doc[field]);
    if (seen.has(key)) {
      duplicates.push(doc);
    } else {
      seen.add(key);
    }
  }

  for (const doc of duplicates) collection.remove(doc);

  if (duplicates.length > 0) {
    log(
      `Removed ${duplicates.length} duplicate document(s) from ${collection.name}.${field}`
    );
  }

  return duplicates.length;
}

/**
 * contexts は「ノートID」または「チャット相手のユーザーID」で一意。
 */
export function dedupeContexts(
  collection: loki.Collection<ContextDoc>,
  log: (message: string) => void
): number {
  const seen = new Set<string>();
  const duplicates: ContextDoc[] = [];

  for (const doc of collection.find()) {
    const key = doc.isChat ? `chat:${doc.userId}` : `note:${doc.noteId}`;
    if (seen.has(key)) {
      duplicates.push(doc);
    } else {
      seen.add(key);
    }
  }

  for (const doc of duplicates) collection.remove(doc);

  if (duplicates.length > 0) {
    log(`Removed ${duplicates.length} duplicate context(s)`);
  }

  return duplicates.length;
}

/**
 * スキーマを最新版に合わせる。何もせず終わった場合は false を返す。
 */
export function migrate(context: MigrationContext): boolean {
  const from = context.meta.schemaVersion ?? 1;
  if (from >= CURRENT_SCHEMA_VERSION) return false;

  context.log(
    `Migrating the memory: schema v${from} -> v${CURRENT_SCHEMA_VERSION}`
  );

  // v1 -> v2: 重複ドキュメントの掃除
  dedupeByField(context.collections.friends, 'userId', context.log);
  dedupeByField(context.collections.moduleData, 'module', context.log);
  dedupeContexts(context.collections.contexts, context.log);

  context.meta.schemaVersion = CURRENT_SCHEMA_VERSION;
  return true;
}
