import type { Note } from '@/misskey/types.js';
import type { DiaryEntry, DiaryRepository } from './diary-repository.js';
import type { LlmCallFn } from './episode-extractor.js';
import type { MoodState } from './mood-state.js';

type DiaryLog = (message: string) => void;

const noopLog: DiaryLog = () => {};

/** 1ノートあたりの最大文字数。長文ノートがプロンプトを圧迫しないための上限。 */
const MAX_NOTE_CHARS = 200;
/** タイムライン全体の最大文字数。トークン上限との安全マージン。 */
const MAX_TOTAL_CHARS = 15000;

const DIARY_SYSTEM_PROMPT = [
  'あなたはMisskey看板娘ボット「藍」です。',
  'ホームタイムラインのノートを読んで、藍自身の主観日記を書いてください。',
  '',
  '要件:',
  '- 藍の一人称の視点で書く（中立的な要約ではなく、藍が何を感じたかを書く）',
  '- 3〜5行の日本語',
  '- タイムラインに誰もいなかった/内容が乏しい場合は、それも藍らしく短く綴る',
  '- 現在の気分が与えられている場合は、そのトーンを反映する',
  '- ユーザーを不快にさせる内容は書かない',
  '',
  '出力形式: 日記本文のみを出力してください（JSONや説明文は不要）。',
].join('\n');

export type TlDiaryDeps = {
  /** Misskey API 呼び出し（notes/timeline を取得する） */
  api: (endpoint: string, param?: Record<string, unknown>) => Promise<unknown>;
  /** 自分（ボット）のアカウントID。自分のノートを除外するために使う。 */
  selfUserId: string;
  repository: DiaryRepository;
  /** 保持する日記の最大件数（設定値。未指定ならリポジトリ既定） */
  maxEntries?: number;
  log?: DiaryLog;
};

/**
 * タイムラインのノートを日記生成用の入力テキストに整形する。
 * 各ノートは200文字で打ち切り、全体で15000文字を超えないようにする。
 * 独り言としてLLMに読ませるため、bot投稿と自分の投稿は index.ts 側で
 * 除外済みを想定しているが、ここでも防御的に除外する。
 */
export function buildTimelineInput(notes: Note[], selfUserId: string): string {
  const lines: string[] = [];
  let total = 0;
  for (const note of notes) {
    if (note.userId === selfUserId) continue;
    if (note.user?.isBot) continue;
    const text = note.text ?? '';
    if (text.length === 0) continue;
    const truncated = text.slice(0, MAX_NOTE_CHARS);
    // 上限到達したら以降のノートは切り捨てる（breakで十分。順序保証は不要）。
    // +1 は改行区切りの分で、連結後も確実に上限内に収める
    if (total + truncated.length + 1 > MAX_TOTAL_CHARS) break;
    lines.push(truncated);
    total += truncated.length + 1;
  }
  return lines.join('\n');
}

/**
 * タイムラインから日記を生成して保存する。
 * LLM失敗・パース失敗時は何も保存せず null を返す
 * （日記生成の失敗が他の機能に影響しないため。絶対に例外を投げない）。
 */
export async function generateTlDiary(
  deps: TlDiaryDeps,
  api: LlmCallFn,
  moodState?: MoodState | null
): Promise<DiaryEntry | null> {
  const log = deps.log ?? noopLog;
  let notes: Note[];
  try {
    notes = (await deps.api('notes/timeline', {
      limit: 30,
    })) as Note[];
  } catch (err: unknown) {
    if (err instanceof Error) {
      log(`TL日記: タイムライン取得エラー: ${err.name} ${err.message}`);
    }
    return null;
  }
  if (!Array.isArray(notes) || notes.length === 0) {
    log('TL日記: タイムラインが空のためスキップします');
    return null;
  }

  // public/home の可視性ノートだけを対象にする（followers-only は
  // 日記経由で内容が第三者に漏れる恐れがあるため除外）
  const eligible = notes.filter(
    (note) =>
      note.userId !== deps.selfUserId &&
      !note.user?.isBot &&
      (note.visibility === 'public' || note.visibility === 'home')
  );
  const timelineText = buildTimelineInput(eligible, deps.selfUserId);
  if (timelineText.length === 0) {
    log('TL日記: 対象ノートがないためスキップします');
    return null;
  }

  let diaryText: string;
  try {
    diaryText = await api(
      DIARY_SYSTEM_PROMPT,
      buildUserPrompt(timelineText, moodState)
    );
  } catch (err: unknown) {
    if (err instanceof Error) {
      log(`TL日記: LLM呼び出しエラー: ${err.name} ${err.message}`);
    }
    return null;
  }

  const content = diaryText.trim();
  if (content.length === 0) {
    log('TL日記: 生成結果が空のため保存しません');
    return null;
  }

  const entry = deps.repository.insert(
    {
      createdAt: Date.now(),
      content,
      moodAtWrite: moodState != null ? moodState.mood : null,
    },
    // 設定の maxEntries を指定しないとリポジトリ既定値(20)が使われ
    // 設定変更が反映されないため明示的に渡す
    { maxEntries: deps.maxEntries }
  );
  log(`TL日記を保存しました (${content.length}字)`);
  return entry;
}

function buildUserPrompt(
  timelineText: string,
  moodState?: MoodState | null
): string {
  return JSON.stringify({
    timeline: timelineText,
    currentMood:
      moodState != null
        ? { mood: moodState.mood, energy: moodState.energy }
        : null,
    hour: new Date().getHours(),
  });
}

/**
 * 保存済みの日記を「藍の最近の日記」として注入するコンテキストを組み立てる。
 * Phase 1 の buildMemoryRecallContext と同じパターン:
 * 最新 maxCount 件・合計 maxChars 字で打ち切り、1件でも上限超えたら
 * その行をスキップする（短い行が救済されるように continue）。
 */
export function buildDiaryContext(
  entries: DiaryEntry[],
  maxCount = 2,
  maxChars = 1000
): string {
  const eligible = entries.slice(0, maxCount);
  if (eligible.length === 0) return '';

  let text = '\n\n【藍の最近の日記】\n';
  let added = false;
  for (const entry of eligible) {
    const line = `・${entry.content}\n`;
    if (text.length + line.length > maxChars) continue;
    text += line;
    added = true;
  }
  // 全行が上限に弾かれた場合はヘッダだけ残さない（空扱いにする）
  return added ? text : '';
}
