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

  it('configures mugi-misskey style aichat.wander and disables legacy autoNote/randomTalk', () => {
    expect(example.gemini?.autoNote?.enabled).toBe(false);
    expect(example.gemini?.randomTalk?.enabled).toBe(false);
    expect(example.aichat?.wander?.enabled).toBe(true);
    expect(example.aichat?.episodeMemory).toBeUndefined();
    expect(example.gemini?.chat?.prompt).not.toContain(
      'ユーザのことをご主人様と認識しています'
    );
  });

  it('configures kiatsu with Open-Meteo coordinates instead of a location code', () => {
    expect(example.kiatsu?.enabled).toBe(true);
    expect(example.kiatsu?.latitude).toBe(36.3219);
    expect(example.kiatsu?.longitude).toBe(139.0033);
    expect(example.kiatsu?.locationName).toBe('高崎市');
    expect(example.kiatsu?.alertThresholdHpa).toBe(-2);
    expect(example.kiatsu?.hysteresisHpa).toBe(0.5);
    expect(example.kiatsu?.maxPostsPerDay).toBe(1);
    // 廃止したキーが残っていないこと
    expect(example.kiatsu?.locationCode).toBeUndefined();
    expect(example.kiatsu?.postIntervalMs).toBeUndefined();
    expect(example.kiatsu?.minPostLevel).toBeUndefined();
  });
});
