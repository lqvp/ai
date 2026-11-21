/**
 * エピソード記憶（会話から抽出した長期記憶）の1件分。
 *
 * 会話履歴はタイムアウトで消えるため、
 * 「2週間後も参照価値がある情報」だけをこの形で持ち越す。
 */
export type EpisodeMemory = {
  /** リポジトリ挿入時に付与される一意ID */
  id: string;
  userId: string;
  kind: 'fact' | 'episode' | 'preference';
  content: string;
  emotion?: string;
  /** 重要度 1-5。回想への注入は上位のみを許可する */
  importance: number;
  tags: string[];
  createdAt: number;
  /** 新しい記憶によって矛盾・更新された場合、その新しい記憶のIDを指す */
  supersededBy?: string;
  /** アーカイブ済み（pruneOldMemories で付与）。検索結果から除外される */
  archivedAt?: number;
};

/** 挿入前（ID未採番）のエピソード記憶。抽出系はこの形を返す。 */
export type NewEpisodeMemory = Omit<EpisodeMemory, 'id'>;
