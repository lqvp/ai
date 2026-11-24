import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonFileStore } from '../src/modules/aichat/json-file-store.js';
import { PlaybookLoader } from '../src/modules/aichat/playbook.js';

type CounterDoc = {
  count: number;
  items: string[];
};

const dirs: string[] = [];

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-aichat-persist-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('JsonFileStore', () => {
  it('serializes concurrent updates without lost updates and leaves no tmp files', async () => {
    const dir = createTempDir();
    const filePath = join(dir, 'state.json');
    const store = new JsonFileStore<CounterDoc>({
      filePath,
      createDefault: () => ({ count: 0, items: [] }),
      normalize: (raw) => {
        const obj = (raw ?? {}) as Partial<CounterDoc>;
        return {
          count: typeof obj.count === 'number' ? obj.count : 0,
          items: Array.isArray(obj.items) ? (obj.items as string[]) : [],
        };
      },
    });

    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.update((cur) => ({
          next: {
            count: cur.count + 1,
            items: [...cur.items, `item-${i}`],
          },
          result: undefined,
        }))
      )
    );

    const loaded = await store.load();
    expect(loaded.count).toBe(12);
    expect(loaded.items).toHaveLength(12);
    const files = readdirSync(dir);
    expect(files).toEqual(['state.json']);
  });

  it('reloads external operator edits on disk before mutating', async () => {
    const dir = createTempDir();
    const filePath = join(dir, 'state.json');
    const store = new JsonFileStore<CounterDoc>({
      filePath,
      createDefault: () => ({ count: 0, items: [] }),
      normalize: (raw) => {
        const obj = (raw ?? {}) as Partial<CounterDoc>;
        return {
          count: typeof obj.count === 'number' ? obj.count : 0,
          items: Array.isArray(obj.items) ? (obj.items as string[]) : [],
        };
      },
    });

    await store.update((cur) => ({
      next: { ...cur, count: 1 },
      result: undefined,
    }));

    // 運用者がファイルを直接編集したケース
    writeFileSync(
      filePath,
      JSON.stringify({ count: 50, items: ['manual-edit'] }),
      'utf8'
    );

    const updated = await store.update((cur) => ({
      next: { ...cur, count: cur.count + 2 },
      result: cur.count + 2,
    }));

    expect(updated).toBe(52);
    const onDisk = JSON.parse(readFileSync(filePath, 'utf8')) as CounterDoc;
    expect(onDisk.items).toEqual(['manual-edit']);
  });

  it('backs up corrupt JSON once without clobbering the file', async () => {
    const dir = createTempDir();
    const filePath = join(dir, 'state.json');
    const corruptRaw = '{ invalid json !!!';
    writeFileSync(filePath, corruptRaw, 'utf8');

    const store = new JsonFileStore<CounterDoc>({
      filePath,
      createDefault: () => ({ count: 0, items: [] }),
      normalize: (raw) => {
        const obj = (raw ?? {}) as Partial<CounterDoc>;
        return {
          count: typeof obj.count === 'number' ? obj.count : 0,
          items: Array.isArray(obj.items) ? (obj.items as string[]) : [],
        };
      },
      now: () => 1700000000000,
    });

    await store.update((cur) => ({
      next: { ...cur, count: cur.count + 1 },
      result: undefined,
    }));

    expect(store.isCorrupted()).toBe(true);
    // 元の壊れたファイルは上書きされない
    expect(readFileSync(filePath, 'utf8')).toBe(corruptRaw);
    const files = readdirSync(dir);
    expect(files.some((f) => f.startsWith('state.json.bak.'))).toBe(true);
  });

  it('strips __proto__, constructor and prototype keys on load', async () => {
    const dir = createTempDir();
    const filePath = join(dir, 'state.json');
    writeFileSync(
      filePath,
      '{"count":3,"items":[],"__proto__":{"polluted":true},"constructor":{"bad":1},"prototype":{"bad":2}}',
      'utf8'
    );

    const store = new JsonFileStore<Record<string, unknown>>({
      filePath,
      createDefault: () => ({}),
      normalize: (raw) => (raw as Record<string, unknown>) ?? {},
    });

    const loaded = await store.load();
    expect(loaded.count).toBe(3);
    expect(({} as { polluted?: unknown }).polluted).toBeUndefined();
    expect(Object.hasOwn(loaded, 'constructor')).toBe(false);
    expect(Object.hasOwn(loaded, 'prototype')).toBe(false);
  });
});

describe('PlaybookLoader', () => {
  it('seeds default PLAYBOOK once, substitutes variables, and hot-reloads edits', async () => {
    const dir = createTempDir();
    const filePath = join(dir, 'PLAYBOOK.md');
    const loader = new PlaybookLoader({
      filePath,
      aiName: '藍ちゃん',
      master: 'owner1',
    });

    const first = await loader.load();
    expect(first).toContain('藍ちゃん');
    expect(first).toContain('owner1');

    // 既存ファイルはシードで上書きされず、編集がホットリロードされる
    writeFileSync(filePath, '# Custom\nMaster: {{master}}', 'utf8');
    await loader.ensureSeeded();
    const reloaded = await loader.load();
    expect(reloaded).toBe('# Custom\nMaster: owner1');
  });

  it('rejects NUL bytes in path and oversized files', async () => {
    expect(() => new PlaybookLoader({ filePath: 'bad\0path' })).toThrow();

    const dir = createTempDir();
    const sub = join(dir, 'nested');
    mkdirSync(sub, { recursive: true });
    const filePath = join(sub, 'PLAYBOOK.md');
    writeFileSync(filePath, 'a'.repeat(70 * 1024), 'utf8');

    const loader = new PlaybookLoader({
      filePath,
      maxFileBytes: 64 * 1024,
    });
    const text = await loader.load();
    // 超過ファイルではなく安全なデフォルトへフォールバックする
    expect(text).toContain('Misskey 交流ルール');
  });
});
