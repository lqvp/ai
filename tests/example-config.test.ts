import { readFileSync } from 'node:fs';
import * as TOML from '@iarna/toml';
import { describe, expect, it } from 'vitest';

const example = TOML.parse(
  readFileSync(new URL('../example.config.toml', import.meta.url), 'utf8')
) as Record<string, any>;

describe('example.config.toml', () => {
  it('keeps top-level keys at the top level', () => {
    // [userAgent] などのテーブル見出しより後ろにトップレベルキーを書くと
    // そのテーブルに取り込まれてしまう（TOML の仕様）。
    expect(example.notingEnabled).toBe(true);
    expect(example.keywordEnabled).toBe(true);
    expect(example.chartEnabled).toBe(true);
    expect(example.memoryDir).toBe('data');
    expect(example.weatherAutoNoteHour).toBe(7);
  });

  it('places the userAgent table at the end', () => {
    expect(example.userAgent).toEqual({
      http: expect.any(String),
      websocket: expect.any(String),
    });
  });

  it('does not contain legacy [http]/[websocket] tables', () => {
    expect(example.http).toBeUndefined();
    expect(example.websocket).toBeUndefined();
  });

  it('has a valid host and token placeholder', () => {
    expect(example.host).toMatch(/^https?:\/\//);
    expect(typeof example.i).toBe('string');
  });
});
