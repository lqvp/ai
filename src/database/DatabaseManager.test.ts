import DatabaseManager from './DatabaseManager.js';
import * as fs from 'fs';
import * as path from 'path';

describe('DatabaseManager', () => {
  let dbManager: DatabaseManager;
  const testDbPath = './test.ai.db';
  const testMigrationMarker = testDbPath + '.migrated';

  beforeEach((done) => {
    // Clean up test database
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (fs.existsSync(testMigrationMarker)) {
      fs.unlinkSync(testMigrationMarker);
    }

    // Set NODE_ENV to test
    process.env.NODE_ENV = 'test';

    dbManager = new DatabaseManager(
      () => done(),
      (err) => done(err)
    );
  });

  afterEach(() => {
    // Clean up
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (fs.existsSync(testMigrationMarker)) {
      fs.unlinkSync(testMigrationMarker);
    }
  });

  test('should initialize database', () => {
    expect(dbManager.db).toBeDefined();
    expect(dbManager.meta).toBeDefined();
    expect(dbManager.contexts).toBeDefined();
    expect(dbManager.timers).toBeDefined();
    expect(dbManager.friends).toBeDefined();
    expect(dbManager.moduleData).toBeDefined();
  });

  test('should create and retrieve meta data', () => {
    const meta = dbManager.getMeta();
    expect(meta).toBeDefined();
    expect(meta.lastWakingAt).toBeDefined();
    expect(typeof meta.lastWakingAt).toBe('number');
  });

  test('should update meta data', () => {
    const newTime = Date.now();
    dbManager.setMeta({ lastWakingAt: newTime });
    
    const meta = dbManager.getMeta();
    expect(meta.lastWakingAt).toBe(newTime);
  });

  test('should create and retrieve collections', () => {
    const testCollection = dbManager.getCollection('testCollection');
    expect(testCollection).toBeDefined();
    expect(testCollection.name).toBe('testCollection');
  });

  test('should insert and find documents', () => {
    const collection = dbManager.getCollection<{ name: string; value: number }>('testDocs');
    
    const doc1 = collection.insertOne({ name: 'test1', value: 100 });
    const doc2 = collection.insertOne({ name: 'test2', value: 200 });
    
    expect(doc1).toBeDefined();
    expect(doc2).toBeDefined();
    
    const found = collection.find({ name: 'test1' });
    expect(found.length).toBe(1);
    expect(found[0].value).toBe(100);
    
    const all = collection.find();
    expect(all.length).toBe(2);
  });

  test('should update documents', () => {
    const collection = dbManager.getCollection<{ id: number; name: string; value: number }>('testUpdate');
    
    const doc = collection.insertOne({ id: 1, name: 'original', value: 100 });
    doc.value = 200;
    collection.update(doc);
    
    const found = collection.findOne({ id: 1 });
    expect(found).toBeDefined();
    expect(found!.value).toBe(200);
  });

  test('should remove documents', () => {
    const collection = dbManager.getCollection<{ id: number; name: string }>('testRemove');
    
    const doc1 = collection.insertOne({ id: 1, name: 'test1' });
    const doc2 = collection.insertOne({ id: 2, name: 'test2' });
    
    collection.remove(doc1);
    
    const all = collection.find();
    expect(all.length).toBe(1);
    expect(all[0].id).toBe(2);
  });

  test('should support chain API', () => {
    const collection = dbManager.getCollection<{ name: string; score: number }>('testChain');
    
    collection.insertOne({ name: 'a', score: 30 });
    collection.insertOne({ name: 'b', score: 10 });
    collection.insertOne({ name: 'c', score: 20 });
    
    const sorted = collection.chain()
      .simplesort('score', true)
      .data();
    
    expect(sorted.length).toBe(3);
    expect(sorted[0].score).toBe(30);
    expect(sorted[1].score).toBe(20);
    expect(sorted[2].score).toBe(10);
  });

  test('should count documents', () => {
    const collection = dbManager.getCollection('testCount');
    
    expect(collection.count()).toBe(0);
    
    collection.insertOne({ value: 1 });
    collection.insertOne({ value: 2 });
    
    expect(collection.count()).toBe(2);
  });

  test('should clear collection', () => {
    const collection = dbManager.getCollection('testClear');
    
    collection.insertOne({ value: 1 });
    collection.insertOne({ value: 2 });
    
    expect(collection.count()).toBe(2);
    
    collection.clear();
    
    expect(collection.count()).toBe(0);
  });
});