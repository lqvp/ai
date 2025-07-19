import DatabaseManager from './DatabaseManager.js';
import * as fs from 'fs';

describe('DatabaseManager Performance', () => {
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

    process.env.NODE_ENV = 'test';

    dbManager = new DatabaseManager(
      () => done(),
      (err) => done(err)
    );
  });

  afterEach(() => {
    dbManager.close();
    // Clean up
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    if (fs.existsSync(testMigrationMarker)) {
      fs.unlinkSync(testMigrationMarker);
    }
  });

  test('should handle bulk inserts efficiently', () => {
    const collection = dbManager.getCollection<{ id: number; data: string }>('perfTest');
    const docs = [];
    const count = 1000;

    // Generate test data
    for (let i = 0; i < count; i++) {
      docs.push({ id: i, data: `test-${i}` });
    }

    const startTime = Date.now();
    collection.insert(docs);
    const insertTime = Date.now() - startTime;

    console.log(`Inserted ${count} documents in ${insertTime}ms`);
    expect(insertTime).toBeLessThan(1000); // Should complete within 1 second

    // Verify all documents were inserted
    expect(collection.count()).toBe(count);
  });

  test('should query documents efficiently', () => {
    const collection = dbManager.getCollection<{ id: number; category: string; value: number }>('queryTest');
    
    // Insert test data
    const docs = [];
    for (let i = 0; i < 1000; i++) {
      docs.push({
        id: i,
        category: `cat-${i % 10}`,
        value: Math.random() * 100
      });
    }
    collection.insert(docs);

    // Test find performance
    const startTime = Date.now();
    const results = collection.find({ category: 'cat-5' });
    const queryTime = Date.now() - startTime;

    console.log(`Found ${results.length} documents in ${queryTime}ms`);
    expect(queryTime).toBeLessThan(100); // Should complete within 100ms
    expect(results.length).toBe(100); // Should find 100 documents
  });

  test('should handle concurrent operations', async () => {
    const collection = dbManager.getCollection<{ id: string; value: number }>('concurrentTest');
    
    const operations = [];
    const operationCount = 100;

    // Create concurrent insert operations
    for (let i = 0; i < operationCount; i++) {
      operations.push(
        new Promise<void>((resolve) => {
          setTimeout(() => {
            collection.insertOne({ id: `doc-${i}`, value: i });
            resolve();
          }, Math.random() * 10);
        })
      );
    }

    const startTime = Date.now();
    await Promise.all(operations);
    const totalTime = Date.now() - startTime;

    console.log(`Completed ${operationCount} concurrent operations in ${totalTime}ms`);
    expect(collection.count()).toBe(operationCount);
  });

  test('should maintain performance with large datasets', () => {
    const collection = dbManager.getCollection<{ id: number; data: string }>('largeDataset');
    
    // Insert a large dataset
    const batchSize = 100;
    const batches = 10;
    
    for (let batch = 0; batch < batches; batch++) {
      const docs = [];
      for (let i = 0; i < batchSize; i++) {
        const id = batch * batchSize + i;
        docs.push({ id, data: `data-${id}` });
      }
      collection.insert(docs);
    }

    // Test query performance on large dataset
    const startTime = Date.now();
    const result = collection.findOne({ id: 500 });
    const queryTime = Date.now() - startTime;

    console.log(`Found document in large dataset in ${queryTime}ms`);
    expect(queryTime).toBeLessThan(50); // Should be very fast
    expect(result).toBeDefined();
    expect(result!.id).toBe(500);
  });
});