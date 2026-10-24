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
});
