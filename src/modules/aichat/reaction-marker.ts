/**
 * パーソナライズドリアクションのマーカー処理。
 *
 * リアクション選択を独立したLLM呼び出しにすると1ノートごとに
 * コストが増えるため、メインの文章生成リクエストの指示に同居させ、
 * 応答末尾の `[[REACTION: ...]]` マーカーとして回収する。
 * tool-call-parser.ts の parseToolCallsFromContent と同じ「埋め込み
 * マークアップを投稿前に剥がす」パターン。
 */

export const REACTION_MARKER_INSTRUCTION = [
  '',
  '【リアクション】',
  '応答メッセージの最終行に、このノートへのリアクション絵文字を必ず1行だけ付けてください。',
  '形式: [[REACTION: 絵文字]] （例: [[REACTION: 😊]]）',
  'リアクションしない方が自然な場合は [[REACTION: none]] としてください。',
  'この行はシステムが削除するため、本文では説明しないこと。',
].join('\n');

/** 末尾の [[REACTION: ...]] マーカーにマッチする正規表現。 */
const REACTION_MARKER_RE = /\[\[REACTION:\s*([^\]]*?)\s*\]\]\s*$/;

export type ReactionMarkerResult = {
  /** 選択された絵文字。none またはパース失敗時は null */
  reaction: string | null;
  /** マーカーを除去した投稿用テキスト */
  cleaned: string;
};

/**
 * 応答テキストから [[REACTION: ...]] マーカーを剥がす。
 * マーカーがなければ cleaned = 元テキスト、reaction = null。
 * 絵文字の検証はしない（Misskey側で不正絵文字はリアクション失敗に
 * なるだけで、投稿本文までは壊れないため）。
 */
export function stripReactionMarker(text: string): ReactionMarkerResult {
  const match = text.match(REACTION_MARKER_RE);
  if (match == null) {
    return { reaction: null, cleaned: text };
  }

  const value = match[1]?.trim() ?? '';
  const reaction = value === '' || value === 'none' ? null : value;

  return {
    reaction,
    cleaned: text.slice(0, match.index).trimEnd(),
  };
}
