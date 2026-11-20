export type MoodState = {
  mood: 'happy' | 'calm' | 'tired' | 'sad' | 'excited';
  energy: number; // 0-100, decays toward baseline 60
  triggers: string[]; // recent mood events, max 5
  updatedAt: number;
};

/**
 * 気分の強さを表す段階。左ほど低く、右ほど高い。
 * 気分はこの隣接段階の間でしか1ステップずつ動かない
 * （急激な気分変化は不自然になるため）。
 */
export const MOOD_LEVELS = [
  'sad',
  'tired',
  'calm',
  'happy',
  'excited',
] as const;

/** エネルギーと気分レベルの安静値。時間経過でここへ戻っていく。 */
export const BASELINE_ENERGY = 60;
export const BASELINE_MOOD_LEVEL = MOOD_LEVELS.indexOf('calm');

/** エネルギー減衰の半減期（24時間）。 */
export const HALF_LIFE_MS = 24 * 60 * 60 * 1000;

/** triggers の保持上限。古い気分イベントは頭から捨てる。 */
export const MAX_TRIGGERS = 5;

/** 1回の更新でエネルギーが動ける最大幅。 */
export const MAX_ENERGY_DELTA = 20;

export function createDefaultMoodState(now = Date.now()): MoodState {
  return {
    mood: 'calm',
    energy: BASELINE_ENERGY,
    triggers: [],
    updatedAt: now,
  };
}

/**
 * 時間経過による気分の自然減衰。
 * エネルギーは BASELINE_ENERGY へ向けて半減期24時間の指数減衰をし、
 * 気分レベルも同様に calm へ近づく。ただし気分は1回の呼び出しで
 * 最大1ステップしか動かない（減衰を段階的に消化するため）。
 */
export function decayMood(state: MoodState, now = Date.now()): MoodState {
  const elapsed = Math.max(0, now - state.updatedAt);
  if (elapsed === 0) return state;

  // remaining = 残存率。24時間で1/2、48時間で1/4 …となる
  const remaining = Math.exp((-elapsed * Math.LN2) / HALF_LIFE_MS);

  const energy = clampEnergy(
    Math.round(BASELINE_ENERGY + (state.energy - BASELINE_ENERGY) * remaining)
  );

  const currentLevel = moodLevelOf(state.mood);
  // calm に向かう目標レベル。あくまで減衰の到達点であって即時の値ではない
  const targetLevel =
    BASELINE_MOOD_LEVEL + (currentLevel - BASELINE_MOOD_LEVEL) * remaining;
  // 1ステップだけ目標へ近づける（切り捨てで方向を決める）
  const step = Math.sign(targetLevel - currentLevel);
  const nextLevel = clampLevel(Math.round(currentLevel + step));

  return {
    ...state,
    energy,
    mood: MOOD_LEVELS[nextLevel],
    updatedAt: now,
  };
}

/** mood 文字列をレベル値へ変換する。不正値は calm 扱いにする。 */
export function moodLevelOf(mood: string): number {
  const level = (MOOD_LEVELS as readonly string[]).indexOf(mood);
  return level === -1 ? BASELINE_MOOD_LEVEL : level;
}

export function clampLevel(level: number): number {
  return Math.min(MOOD_LEVELS.length - 1, Math.max(0, level));
}

export function clampEnergy(energy: number): number {
  return Math.min(100, Math.max(0, Math.round(energy)));
}

/** triggers の末尾に追加し、上限を超えた古いものから捨てる。 */
export function appendTriggers(triggers: string[], added: string[]): string[] {
  const merged = [...triggers, ...added];
  return merged.slice(Math.max(0, merged.length - MAX_TRIGGERS));
}
