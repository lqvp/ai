import got from 'got';
import config from '@/config/index.js';
import { getGeminiApiUrl } from './constants.js';
import type { EpisodeMemory, NewEpisodeMemory } from './episode-memory.js';
import { resolveOpenaiSettings } from './openai-settings.js';

/**
 * LLM呼び出しの抽象。テストでは差し替えられるように関数として渡す。
 * 失敗時は例外を投げず、呼び出し側でハンドリングする。
 */
export type LlmCallFn = (system: string, user: string) => Promise<string>;

type MemoryLog = (message: string) => void;

const noopLog: MemoryLog = () => {};

/** 抽出された記憶のLLM出力スキーマ（ID・createdAtはこちらで付与する）。 */
type ExtractedMemory = {
  kind: 'fact' | 'episode' | 'preference';
  content: string;
  importance: number;
  tags: string[];
};

const EXTRACT_SYSTEM_PROMPT = [
  'あなたはMisskeyボットの長期記憶抽出担当です。',
  'ユーザーとの会話ログから、長期記憶として保存する価値のある情報を抽出してください。',
  '',
  '抽出条件（いずれかに該当するもののみ）:',
  '(a) 2週間後も参照する価値がある情報',
  '(b) ユーザーの属性・好み・家族構成・継続的な用件に関する情報',
  '(c) ユーザーにとって感情的に意味のある出来事',
  '',
  '除外: 一時的な雑談、天気などのすぐ古くなる情報、ボット自身の発言内容',
  '',
  '出力形式: JSON配列のみを出力してください。各要素は以下の形:',
  '[{"kind": "fact|episode|preference", "content": "記憶内容の要約", "importance": 1-5の整数, "tags": ["タグ"]}]',
  '保存するものがない場合は [] を出力してください。',
].join('\n');

const CONTRADICTION_SYSTEM_PROMPT = [
  'あなたはMisskeyボットの長期記憶管理担当です。',
  '新しい記憶のリストと既存の記憶のリストを比較し、',
  '新しい記憶が既存の記憶を矛盾・更新によって置き換えるかを判定してください。',
  '同一の事実の言い換えや、古い情報の更新（例: 引っ越し前の住所 → 新しい住所）が該当します。',
  '単なる関連情報・補足情報は置き換えとしません。',
  '',
  '出力形式: JSON配列のみを出力してください。各要素は以下の形:',
  '[{"newIndex": 新しい記憶のindex番号, "supersedeIds": [置き換える既存記憶のIDの配列]}]',
  '置き換えるものがない場合は [] を出力してください。',
].join('\n');

/**
 * 会話履歴からエピソード記憶を抽出する。
 * LLM出力のパース失敗時は [] を返す（抽出失敗で会話フローを壊さないため）。
 * ユーザー発言を含むため、プロンプトインジェクション対策として
 * 出力は JSON の構造検証のみで扱う。
 */
export async function extractEpisodes(
  history: { role: string; content: string }[],
  userId: string,
  api: LlmCallFn,
  log: MemoryLog = noopLog
): Promise<NewEpisodeMemory[]> {
  // 会話が短すぎる場合、LLM呼び出しコストを節約するため抽出しない
  if (history.length < 2) return [];
  const totalChars = history.reduce(
    (sum, item) => sum + (item.content?.length ?? 0),
    0
  );
  if (totalChars < 100) return [];

  let text: string;
  try {
    text = await api(
      EXTRACT_SYSTEM_PROMPT,
      JSON.stringify(history.map(({ role, content }) => ({ role, content })))
    );
  } catch (err: unknown) {
    if (err instanceof Error) {
      log(`記憶抽出LLM呼び出しエラー: ${err.name} ${err.message}`);
    }
    return [];
  }

  return parseExtractedMemories(text, userId, log);
}

/** LLM応答テキストから記憶配列を取り出す。JSON部分を抽出して検証する。 */
function parseExtractedMemories(
  text: string,
  userId: string,
  log: MemoryLog
): NewEpisodeMemory[] {
  const match = text.match(/\[[\s\S]*\]/);
  if (match == null) {
    log('記憶抽出: 応答にJSON配列が見つかりませんでした');
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    log('記憶抽出: JSONのパースに失敗しました');
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const memories: NewEpisodeMemory[] = [];
  for (const item of parsed) {
    const memory = validateExtractedMemory(item);
    if (memory == null) continue;
    memories.push({ ...memory, userId, createdAt: Date.now() });
  }
  return memories;
}

/** 1件の抽出結果を検証する。不正な要素は null で落とす。 */
function validateExtractedMemory(item: unknown): ExtractedMemory | null {
  if (item == null || typeof item !== 'object') return null;
  const raw = item as Partial<ExtractedMemory>;
  const { kind, content, importance, tags } = raw;
  if (kind == null || content == null || importance == null || tags == null) {
    return null;
  }
  if (
    (kind !== 'fact' && kind !== 'episode' && kind !== 'preference') ||
    content.length === 0 ||
    !Number.isInteger(importance) ||
    importance < 1 ||
    importance > 5 ||
    !Array.isArray(tags) ||
    tags.some((tag) => typeof tag !== 'string')
  ) {
    return null;
  }
  return { kind, content, importance, tags };
}

/**
 * 矛盾解消: 新しい記憶がどの既存記憶を置き換えるかをマップで返す。
 * key = 新しい記憴の配列index, value = 置き換え対象の既存記憶IDの配列。
 * 失敗時は空のマップを返す（矛盾処理をスキップしてすべて挿入する）。
 */
export async function resolveContradictions(
  newMemories: NewEpisodeMemory[],
  existingMemories: EpisodeMemory[],
  api: LlmCallFn,
  log: MemoryLog = noopLog
): Promise<Map<number, string[]>> {
  if (newMemories.length === 0 || existingMemories.length === 0) {
    return new Map();
  }

  let text: string;
  try {
    text = await api(
      CONTRADICTION_SYSTEM_PROMPT,
      JSON.stringify({
        newMemories: newMemories.map((m, index) => ({
          index,
          content: m.content,
        })),
        existingMemories: existingMemories.map((m) => ({
          id: m.id,
          content: m.content,
        })),
      })
    );
  } catch (err: unknown) {
    if (err instanceof Error) {
      log(`矛盾解消LLM呼び出しエラー: ${err.name} ${err.message}`);
    }
    return new Map();
  }

  return parseSupersessionMapping(
    text,
    newMemories.length,
    existingMemories,
    log
  );
}

/** LLM応答から置き換えマッピングを取り出す。範囲外のindex/idは無視する。 */
function parseSupersessionMapping(
  text: string,
  newCount: number,
  existingMemories: EpisodeMemory[],
  log: MemoryLog
): Map<number, string[]> {
  const match = text.match(/\[[\s\S]*\]/);
  if (match == null) {
    log('矛盾解消: 応答にJSON配列が見つかりませんでした');
    return new Map();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    log('矛盾解消: JSONのパースに失敗しました');
    return new Map();
  }

  if (!Array.isArray(parsed)) return new Map();

  const validIds = new Set(existingMemories.map((m) => m.id));
  const result = new Map<number, string[]>();
  for (const item of parsed) {
    if (item == null || typeof item !== 'object') continue;
    const { newIndex, supersedeIds } = item as {
      newIndex?: unknown;
      supersedeIds?: unknown;
    };
    if (
      !Number.isInteger(newIndex) ||
      (newIndex as number) < 0 ||
      (newIndex as number) >= newCount ||
      !Array.isArray(supersedeIds)
    ) {
      continue;
    }
    const ids = supersedeIds.filter(
      (id): id is string => typeof id === 'string' && validIds.has(id)
    );
    if (ids.length > 0) {
      result.set(newIndex as number, ids);
    }
  }
  return result;
}

/**
 * 本番用の LlmCallFn 実装（OpenAI互換API / got）。
 * ノート選択と同じ postChatCompletion パターンで、
 * 設定は呼び出し毎に解決する（テストで差し替えやすくするため）。
 */
export function createOpenaiLlmCall(log: MemoryLog = noopLog): LlmCallFn {
  return async (system: string, user: string): Promise<string> => {
    const settings = resolveOpenaiSettings();

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // キー不要のエンドポイント（vLLM など）では Authorization を送らない
    if (settings.apiKey) {
      headers.Authorization = `Bearer ${settings.apiKey}`;
    }

    const body = {
      model: settings.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      temperature: 0.1,
      ...(settings.maxTokens !== undefined
        ? { max_tokens: settings.maxTokens }
        : {}),
    };

    const res = await got
      .post(settings.apiUrl, {
        headers,
        json: body,
        responseType: 'json',
        timeout: { request: settings.timeoutMs },
      })
      .json<{ choices?: { message?: { content?: unknown } }[] }>();

    const content = res.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || content.length === 0) {
      log('記憶系LLM呼び出し: 応答本文が空でした');
      return '';
    }
    return content;
  };
}

/**
 * Gemini プロバイダー選択時の LlmCallFn。
 * gemini.generateContent API に system+user の2パートだけを送る最小構成で、
 * 抽出用途（短い JSON 応答）に限定する。
 */
export function createGeminiLlmCall(log: MemoryLog = noopLog): LlmCallFn {
  return async (system: string, user: string): Promise<string> => {
    const geminiConfig = config.gemini;
    if (geminiConfig?.apiKey == null || geminiConfig.model == null) {
      log('記憶系LLM呼び出し: Gemini設定が不完全です');
      return '';
    }
    const url = getGeminiApiUrl();
    const res = await got
      .post(url, {
        headers: { 'x-goog-api-key': geminiConfig.apiKey },
        json: {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
        },
        responseType: 'json',
        timeout: { request: 60_000 },
      })
      .json<{
        candidates?: { content?: { parts?: { text?: string }[] } }[];
      }>();

    const parts = res.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p) => p.text ?? '')
      .join('')
      .trim();
    if (text.length === 0) {
      log('記憶系LLM呼び出し: Gemini応答本文が空でした');
      return '';
    }
    return text;
  };
}

/**
 * 選択中のプロバイダーに応じた LlmCallFn を返す。
 * 記憶抽出・気分・日記・フォローアップの補助LLM呼び出しは
 * メイン会話のプロバイダー設定と同じものを使う。
 */
export function createAuxLlmCall(log: MemoryLog = noopLog): LlmCallFn {
  return config.aiProvider?.provider === 'gemini'
    ? createGeminiLlmCall(log)
    : createOpenaiLlmCall(log);
}
