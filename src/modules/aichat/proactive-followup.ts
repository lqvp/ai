import type { LlmCallFn } from './episode-extractor.js';
import type { EpisodeMemory } from './episode-memory.js';
import type { FollowupStateRepository } from './followup-state.js';

type FollowupLog = (message: string) => void;

const noopLog: FollowupLog = () => {};

/** フォローアップ送信が歓迎される記憶の重要度しきい値。 */
const MIN_IMPORTANCE = 3;

/** フォローアップ本文の最大長。1〜2文の指示に余裕を持たせた上限。 */
const MAX_MESSAGE_LENGTH = 300;

/** LLMが返すフォローアップ候補の形。 */
export type FollowUpCandidate = {
  userId: string;
  message: string;
  reason: string;
};

const DECIDE_SYSTEM_PROMPT = [
  'あなたはMisskey看板娘の女の子AI、三須木(みすき)藍（精神年齢14〜16才程度）の',
  'フォローアップ判断担当です。藍は従順で献身的な看板娘で、丁寧で親しみのある口調で話します。',
  '',
  'ユーザーの長期記憶リストを読み、フォローアップ（「昨日の〇〇どうなった？」のような気遣いの声かけ）を',
  '送るべき記憶があるか判断してください。',
  '',
  '送ってよいもの（継続的な関心事のみ）:',
  '- 仕事・健康・継続的な用件など、相手の状況を本当に気にかけるべき主題',
  '',
  '送ってはいけないもの:',
  '- どうでもいい雑談の事実や、単なる好みの確認',
  '- ユーザーが深追いを望まなそうなセンシティブな話題（プライベートの深い部分）',
  '- 返信を期待するだけで相手を疲わせる内容',
  '',
  'メッセージの条件:',
  '- 藍として温かく、キャラを守る（1〜2文で簡潔に）',
  '- 記憶の実際の内容に言及すること（内容と無関係な挨拶は禁止）',
  '',
  '大切なこと: 本当に送る価値があるものがない場合は黙っているのが正解です。',
  '無理に話題を作らず、空の配列を返してください。',
  '',
  '出力形式: JSONオブジェクトのみを出力してください。',
  '{"followUps": [{"userId": "ユーザーID", "message": "フォローアップ本文", "reason": "判断理由"}]}',
  '送るものがない場合は {"followUps": []} を出力してください。',
].join('\n');

/**
 * LLMにフォローアップ判断を問い、候補リストを返す。
 * 失敗時は例外を投げず空配列を返す（定期ジョブを止めないため）。
 * 記憶はユーザー発言由来のため、出力は JSON の構造検証のみで扱う。
 */
export async function decideFollowUps(
  memories: EpisodeMemory[],
  api: LlmCallFn,
  log: FollowupLog = noopLog
): Promise<FollowUpCandidate[]> {
  // 重要度3未満の記憶はうっかり雑談を掘り返す元なので、LLMに渡さない
  const eligible = memories.filter(
    (memory) =>
      memory.importance >= MIN_IMPORTANCE &&
      memory.archivedAt == null &&
      memory.supersededBy == null
  );
  if (eligible.length === 0) return [];

  // ユーザーごとにLLM入力を分離する。複数ユーザーの記憶を1つの入力に
  // 混ぜると、LLMがAの記憶をBへの本文に使う漏えいが起きうるため。
  const byUser = new Map<string, EpisodeMemory[]>();
  for (const memory of eligible) {
    const list = byUser.get(memory.userId) ?? [];
    list.push(memory);
    byUser.set(memory.userId, list);
  }

  const candidates: FollowUpCandidate[] = [];
  for (const [userId, userMemories] of byUser) {
    let text: string;
    try {
      text = await api(
        DECIDE_SYSTEM_PROMPT,
        JSON.stringify(
          userMemories.map((memory) => ({
            userId: memory.userId,
            content: memory.content,
            importance: memory.importance,
            createdAt: memory.createdAt,
          }))
        )
      );
    } catch (err: unknown) {
      if (err instanceof Error) {
        log(
          `フォローアップ判断LLM呼び出しエラー(${userId}): ${err.name} ${err.message}`
        );
      }
      continue;
    }

    // 送信先は入力側のユーザーに固定する（LLMの出力userIdは信用しない）
    for (const candidate of parseFollowUps(text, log)) {
      if (candidate.userId === userId) candidates.push(candidate);
    }
  }
  return candidates;
}

/** LLM応答テキストから候補を取り出す。JSON部分を抽出して検証する。 */
function parseFollowUps(text: string, log: FollowupLog): FollowUpCandidate[] {
  const match = text.match(/\{[\s\S]*\}/);
  if (match == null) {
    log('フォローアップ判断: 応答にJSONが見つかりませんでした');
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(match[0]);
  } catch {
    log('フォローアップ判断: JSONのパースに失敗しました');
    return [];
  }

  const raw = parsed as { followUps?: unknown };
  if (!Array.isArray(raw.followUps)) return [];

  const candidates: FollowUpCandidate[] = [];
  for (const item of raw.followUps) {
    const candidate = validateCandidate(item);
    if (candidate == null) continue;
    candidates.push(candidate);
  }
  return candidates;
}

/** 1件の候補を検証する。不正な要素は null で落とす。 */
function validateCandidate(item: unknown): FollowUpCandidate | null {
  if (item == null || typeof item !== 'object') return null;
  const raw = item as Partial<FollowUpCandidate>;
  const { userId, message, reason } = raw;
  if (
    typeof userId !== 'string' ||
    userId.length === 0 ||
    typeof message !== 'string' ||
    message.length === 0 ||
    message.length > MAX_MESSAGE_LENGTH ||
    typeof reason !== 'string'
  ) {
    return null;
  }
  return { userId, message, reason };
}

/** 依存注入。index.ts から実環境を、テストからモックを渡す。 */
export type ProactiveFollowUpDeps = {
  memories: EpisodeMemory[];
  api: LlmCallFn;
  state: FollowupStateRepository;
  /** friends コレクションに存在するユーザーか（フォロー関係の代理判定） */
  isFriend: (userId: string) => boolean;
  /** マスターユーザーか。頻度制限のみ免除される */
  isMasterUser: (userId: string) => Promise<boolean> | boolean;
  /** チャット（DM）でメッセージを送信する */
  send: (userId: string, message: string) => Promise<unknown>;
  /** 指定時刻以降にユーザーとのやり取りがあったか（無視判定に使う） */
  hasInteractedSince: (userId: string, since: number) => Promise<boolean>;
  now?: () => number;
  /** 同一ユーザーへの再送スロットル（既定72時間） */
  userThrottleMs?: number;
  /** 連続無視後のクールダウン（既定7日） */
  cooldownMs?: number;
  /** フォローアップの無視とみなす猶予（既定24時間） */
  ignoreWindowMs?: number;
};

/**
 * プロアクティブフォローアップの本体。どのパスでも例外を投げない。
 * 1実行あたり最大1通のみ送る（maxPerDay設定は現状1で固定）。
 * @returns 送信した候補。送らなければ null。
 */
export async function runProactiveFollowUp(
  deps: ProactiveFollowUpDeps,
  log: FollowupLog = noopLog
): Promise<FollowUpCandidate | null> {
  const now = deps.now?.() ?? Date.now();
  const userThrottleMs = deps.userThrottleMs ?? 72 * 60 * 60 * 1000;
  const cooldownMs = deps.cooldownMs ?? 7 * 24 * 60 * 60 * 1000;
  const ignoreWindowMs = deps.ignoreWindowMs ?? 24 * 60 * 60 * 1000;

  // まず前回のフォローアップの無視判定を確定する
  // （クールダウン発動はここの状態更新で始まる）
  for (const state of deps.state.findAll()) {
    try {
      const interacted = await deps.hasInteractedSince(
        state.userId,
        state.lastFollowUpAt ?? 0
      );
      if (interacted) {
        deps.state.markReplied(state.userId);
      } else {
        deps.state.settleIgnored(
          state.userId,
          false,
          now,
          ignoreWindowMs,
          cooldownMs
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error) {
        log(`フォローアップ無視判定エラー: ${err.name} ${err.message}`);
      }
    }
  }

  let candidates: FollowUpCandidate[];
  try {
    candidates = await decideFollowUps(deps.memories, deps.api, log);
  } catch {
    // decideFollowUps は内部で例外を握っているが、念のため二重防御
    return null;
  }
  if (candidates.length === 0) return null;

  // 1実行1通。複数候補が出ても最初の1件だけ採用する
  const candidate = candidates[0];

  try {
    // フレンドでない（=相互フォローが確認できない）相手には送らない
    if (!deps.isFriend(candidate.userId)) {
      log(`フォローアップ: ${candidate.userId} はフレンドでないためスキップ`);
      return null;
    }

    const isMaster = await deps.isMasterUser(candidate.userId);
    // マスターは頻度制限免除。それ以外はスロットルとクールダウンを守る
    if (
      !isMaster &&
      !deps.state.canSend(candidate.userId, userThrottleMs, now)
    ) {
      log(`フォローアップ: ${candidate.userId} はスロットル/クールダウン中`);
      return null;
    }

    await deps.send(candidate.userId, candidate.message);
    deps.state.recordFollowUp(candidate.userId, now);
    log(`フォローアップを送信しました: ${candidate.userId}`);
    return candidate;
  } catch (err: unknown) {
    if (err instanceof Error) {
      log(`フォローアップ送信エラー: ${err.name} ${err.message}`);
    }
    return null;
  }
}
