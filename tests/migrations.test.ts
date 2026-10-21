import loki from 'lokijs';
import { describe, expect, it, vi } from 'vitest';
import type { Meta } from '../src/ai.js';
import {
  CURRENT_SCHEMA_VERSION,
  dedupeByField,
  dedupeContexts,
  migrate,
} from '../src/database/migrations.js';
import type {
  ContextDoc,
  FriendDoc,
  ModuleDataDoc,
} from '../src/database/repositories.js';

const newDb = () => new loki('migration.db', { autosave: false });

describe('dedupeByField', () => {
  it('keeps the first document for each key', () => {
    const db = newDb();
    const collection = db.addCollection<FriendDoc>('friends', {
      indices: ['userId'],
    });
    collection.insert({ userId: 'u1', user: { id: 'u1' } } as FriendDoc);
    collection.insert({
      userId: 'u1',
      user: { id: 'u1', name: 'dup' },
    } as FriendDoc);
    collection.insert({ userId: 'u2', user: { id: 'u2' } } as FriendDoc);

    const log = vi.fn();
    expect(dedupeByField(collection, 'userId', log)).toBe(1);
    expect(collection.count()).toBe(2);
    expect(collection.findOne({ userId: 'u1' })?.user.name).toBeUndefined();
    expect(log).toHaveBeenCalledOnce();
  });
});

describe('dedupeContexts', () => {
  it('dedupes note and chat contexts independently', () => {
    const db = newDb();
    const collection = db.addCollection<ContextDoc>('contexts', {
      indices: ['noteId', 'userId'],
    });
    collection.insert({ isChat: false, noteId: 'n1', module: 'a', key: 'k' });
    collection.insert({ isChat: false, noteId: 'n1', module: 'b', key: 'k2' });
    collection.insert({ isChat: true, userId: 'u1', module: 'a', key: 'k' });
    collection.insert({ isChat: true, userId: 'u1', module: 'b', key: 'k2' });

    expect(dedupeContexts(collection, () => {})).toBe(2);
    expect(collection.count()).toBe(2);
  });
});

describe('migrate', () => {
  it('is a no-op for an up-to-date schema', () => {
    const db = newDb();
    const meta = { lastWakingAt: 0, schemaVersion: CURRENT_SCHEMA_VERSION };
    const friends = db.addCollection<FriendDoc>('friends');
    const moduleData = db.addCollection<ModuleDataDoc>('moduleData');
    const contexts = db.addCollection<ContextDoc>('contexts');
    friends.insert({ userId: 'u1', user: { id: 'u1' } } as FriendDoc);

    expect(
      migrate({
        meta,
        collections: { friends, moduleData, contexts },
        log: () => {},
      })
    ).toBe(false);
  });

  it('bumps the schema version and cleans duplicates from v1', () => {
    const db = newDb();
    const meta: Meta = { lastWakingAt: 0 };
    const friends = db.addCollection<FriendDoc>('friends');
    const moduleData = db.addCollection<ModuleDataDoc>('moduleData');
    const contexts = db.addCollection<ContextDoc>('contexts');

    friends.insert({ userId: 'u1', user: { id: 'u1' } } as FriendDoc);
    friends.insert({ userId: 'u1', user: { id: 'u1' } } as FriendDoc);
    moduleData.insert({ module: 'aichat', data: {} });
    moduleData.insert({ module: 'aichat', data: {} });
    contexts.insert({ isChat: false, noteId: 'n1', module: 'a', key: 'k' });
    contexts.insert({ isChat: false, noteId: 'n1', module: 'b', key: 'k' });

    const applied = migrate({
      meta,
      collections: { friends, moduleData, contexts },
      log: () => {},
    });

    expect(applied).toBe(true);
    expect(meta.schemaVersion).toBe(CURRENT_SCHEMA_VERSION);
    expect(friends.count()).toBe(1);
    expect(moduleData.count()).toBe(1);
    expect(contexts.count()).toBe(1);
  });
});
