import { describe, expect, it } from 'vitest';
import type { LlmCallFn } from '../src/modules/aichat/episode-extractor.js';
import {
  buildMoodContextText,
  updateMood,
} from '../src/modules/aichat/mood-engine.js';
import type { MoodState } from '../src/modules/aichat/mood-state.js';
import { createDefaultMoodState } from '../src/modules/aichat/mood-state.js';

function mockApi(response: string): LlmCallFn {
  return async () => response;
}

function throwingApi(): LlmCallFn {
  return async () => {
    throw new Error('API down');
  };
}

const baseState: MoodState = { ...createDefaultMoodState(0) };

describe('updateMood', () => {
  it('updates mood with valid JSON response', async () => {
    const api = mockApi(
      JSON.stringify({
        mood: 'happy',
        energy: 75,
        triggers: ['楽しい会話だった'],
      })
    );
    const next = await updateMood(
      baseState,
      { recentConversation: '会話', hour: 12 },
      api
    );
    expect(next.mood).toBe('happy');
    expect(next.energy).toBe(75);
    expect(next.triggers).toEqual(['楽しい会話だった']);
  });

  it('clamps mood to at most one step from current', async () => {
    // calm から excited（2段階上）への要求は happy に正規化される
    const api = mockApi(
      JSON.stringify({ mood: 'excited', energy: 100, triggers: [] })
    );
    const next = await updateMood(baseState, { hour: 10 }, api);
    expect(next.mood).toBe('happy');
  });

  it('clamps energy to ±20 from current', async () => {
    const api = mockApi(
      JSON.stringify({ mood: 'calm', energy: 100, triggers: [] })
    );
    const next = await updateMood(baseState, { hour: 10 }, api);
    expect(next.energy).toBe(80);
  });

  it('returns current state unchanged on invalid JSON', async () => {
    const api = mockApi('気分は良いです！');
    const next = await updateMood(baseState, { hour: 10 }, api);
    expect(next).toEqual(baseState);
  });

  it('returns current state when response has no JSON object', async () => {
    const api = mockApi('no json here');
    const next = await updateMood(baseState, { hour: 10 }, api);
    expect(next).toEqual(baseState);
  });

  it('never throws when the LLM call fails', async () => {
    const next = await updateMood(baseState, { hour: 10 }, throwingApi());
    expect(next).toEqual(baseState);
  });

  it('keeps triggers capped at 5', async () => {
    const api = mockApi(
      JSON.stringify({
        mood: 'calm',
        energy: 60,
        triggers: ['a', 'b', 'c', 'd', 'e', 'f'],
      })
    );
    const state = { ...baseState, triggers: ['x'] };
    const next = await updateMood(state, { hour: 10 }, api);
    expect(next.triggers).toHaveLength(5);
    expect(next.triggers).not.toContain('x');
  });
});

describe('buildMoodContextText', () => {
  it('includes mood and the consideration guard', () => {
    const text = buildMoodContextText({
      ...baseState,
      mood: 'sad',
      energy: 30,
    });
    expect(text).toContain('sad');
    expect(text).toContain('演技として自然に反映');
    expect(text).toContain('落ち込んでいてもユーザーに心配をかけすぎない');
  });
});
