import type { LlmCallFn } from './episode-extractor.js';
import type { MoodState } from './mood-state.js';
import {
  appendTriggers,
  clampEnergy,
  clampLevel,
  MAX_ENERGY_DELTA,
  moodLevelOf,
} from './mood-state.js';

type MoodLog = (message: string) => void;

const noopLog: MoodLog = () => {};

export type MoodUpdateContext = {
  /** 直近の会話ログ（会話終了時に渡す） */
  recentConversation?: string;
  /** タイムラインの要約テキスト（定期ジョブで渡す） */
  timelineSummary?: string;
  /** 現在時刻（0-23） */
  hour: number;
};

const MOOD_SYSTEM_PROMPT = [
  'あなたはMisskey看板娘ボット「藍」の気分エンジンです。',
  '直前の会話やタイムラインの内容から、藍自身の今の気分を更新してください。',
  '藍は感情を持つキャラクターとして振る舞いますが、気分の変化は緩やかです。',
  '',
  '制約:',
  '- mood は現在値から最大1段階しか変えられない（段階: sad < tired < calm < happy < excited）',
  '- energy は現在値から ±20 以内で変化させる',
  '- 気分の理由を triggers に短く記録する（最大5件）',
  '',
  '出力形式: 次のJSONのみを出力してください（説明文は不要）:',
  '{"mood": "sad|tired|calm|happy|excited", "energy": 0-100の整数, "triggers": ["気分変化の理由"]}',
].join('\n');

/**
 * 直前の状態と文脈から気分を更新する。
 * LLM呼び出しやパースに失敗した場合は現在の状態をそのまま返す
 * （気分更新の失敗が会話フローを壊さないため。絶対に例外を投げない）。
 */
export async function updateMood(
  currentState: MoodState,
  context: MoodUpdateContext,
  api: LlmCallFn,
  log: MoodLog = noopLog
): Promise<MoodState> {
  let text: string;
  try {
    text = await api(
      MOOD_SYSTEM_PROMPT,
      buildUserPrompt(currentState, context)
    );
  } catch (err: unknown) {
    if (err instanceof Error) {
      log(`気分更新LLM呼び出しエラー: ${err.name} ${err.message}`);
    }
    return currentState;
  }

  const next = parseMoodResponse(text, currentState, log);
  return next == null ? currentState : next;
}

/** 現在の気分を応答の演技として反映するためのコンテキスト指示。 */
export function buildMoodContextText(state: MoodState): string {
  return (
    '\n\n【現在の気分】\n' +
    `あなたは今「${state.mood}」で元気度${state.energy}（0-100）の状態です。` +
    'これを演技として自然に反映してください。' +
    'ただし落ち込んでいてもユーザーに心配をかけすぎないこと。\n'
  );
}

function buildUserPrompt(state: MoodState, context: MoodUpdateContext): string {
  return JSON.stringify({
    currentMood: {
      mood: state.mood,
      energy: state.energy,
      triggers: state.triggers,
    },
    recentConversation: context.recentConversation ?? '',
    timelineSummary: context.timelineSummary ?? '',
    hour: context.hour,
  });
}

/** LLM応答から気分状態を取り出し、制約へ正規化する。不正なら null。 */
function parseMoodResponse(
  text: string,
  currentState: MoodState,
  log: MoodLog
): MoodState | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (match == null) {
    log('気分更新: 応答にJSONが見つかりませんでした');
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    log('気分更新: JSONのパースに失敗しました');
    return null;
  }

  if (parsed == null || typeof parsed !== 'object') return null;
  const raw = parsed as Partial<{
    mood: unknown;
    energy: unknown;
    triggers: unknown;
  }>;

  // mood: 不正値なら更新しない（現在値を維持）
  const nextMood =
    typeof raw.mood === 'string'
      ? moodLevelOf(raw.mood)
      : moodLevelOf(currentState.mood);
  const currentLevel = moodLevelOf(currentState.mood);

  // 最大1段階の制約をここでも強制する（LLMが守らなくても破綻しない）
  const clampedLevel = clampLevel(
    currentLevel + Math.max(-1, Math.min(1, nextMood - currentLevel))
  );

  // energy: ±20 の制約を強制する
  const requestedEnergy =
    typeof raw.energy === 'number' && Number.isFinite(raw.energy)
      ? Math.round(raw.energy)
      : currentState.energy;
  const energy = clampEnergy(
    Math.max(
      currentState.energy - MAX_ENERGY_DELTA,
      Math.min(currentState.energy + MAX_ENERGY_DELTA, requestedEnergy)
    )
  );

  const triggers =
    Array.isArray(raw.triggers) &&
    raw.triggers.every((t) => typeof t === 'string')
      ? appendTriggers(currentState.triggers, raw.triggers)
      : currentState.triggers;

  return {
    mood: (['sad', 'tired', 'calm', 'happy', 'excited'] as const)[clampedLevel],
    energy,
    triggers,
    updatedAt: Date.now(),
  };
}
