import loki from 'lokijs';
import { describe, expect, it } from 'vitest';
import { initConfig, resolveConfig } from '../src/config.js';
import KeywordModule from '../src/modules/keyword/index.js';

describe('keyword module collection', () => {
  it('creates the learned-keywords collection with an index on keyword', () => {
    initConfig(
      resolveConfig({
        host: 'https://example.com/',
        i: 'token',
        keywordEnabled: true,
      })
    );

    const db = new loki('test-keyword');
    const captured: { name?: string; indices?: string[] } = {};

    const mod = new KeywordModule();
    (mod as unknown as { ai: unknown }).ai = {
      getCollection: (name: string, opts?: { indices?: string[] }) => {
        captured.name = name;
        captured.indices = opts?.indices;
        return db.addCollection(name, opts);
      },
    };

    mod.install();

    // クエリはすべて keyword 一致のため、インデックスが userId だと効かない
    expect(captured.name).toBe('_keyword_learnedKeywords');
    expect(captured.indices).toContain('keyword');
    expect(captured.indices).not.toContain('userId');
  });

  it('adds the keyword index to a pre-existing collection (legacy env)', () => {
    initConfig(
      resolveConfig({
        host: 'https://example.com/',
        i: 'token',
        keywordEnabled: true,
      })
    );

    const db = new loki('test-keyword-existing');
    // 旧環境: userId インデックスのみで作成済みのコレクションが残っている
    db.addCollection('_keyword_learnedKeywords', { indices: ['userId'] });

    const mod = new KeywordModule();
    (mod as unknown as { ai: unknown }).ai = {
      // DatabaseManager.getCollection と同じく、既存があれば indices を適用せず返す
      getCollection: (name: string, opts?: { indices?: string[] }) =>
        db.getCollection(name) ?? db.addCollection(name, opts),
    };

    mod.install();

    const collection = db.getCollection('_keyword_learnedKeywords');
    expect(collection && 'keyword' in collection.binaryIndices).toBe(true);
  });
});
