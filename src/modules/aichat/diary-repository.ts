import { randomUUID } from 'node:crypto';
import type loki from 'lokijs';

/** TL日記の1エントリ。moodAtWrite は書いた時点の気分スナップショット。 */
export type DiaryEntry = {
  id: string;
  createdAt: number;
  content: string;
  /** 日記生成時の気分（気分エンジン無効時は null）。 */
  moodAtWrite: string | null;
};

/** 挿入時は id / createdAt はリポジトリ側で付与する。 */
export type NewDiaryEntry = Omit<DiaryEntry, 'id'>;

/**
 * `aichatDiary` コレクションへのアクセスをまとめる。
 * EpisodeMemoryRepository と同じく、クエリの意味をここに集約する。
 * 保持上限（maxEntries）と保持期間（retentionHours）の2軸で整理し、
 * 古いものから物理削除する（日記は会話記憶と違い復元価値が低いため）。
 */
export class DiaryRepository {
  constructor(private readonly collection: loki.Collection<DiaryEntry>) {}

  /** 日記を1件挿入する。挿入後に保持ポリシーを適用して余分な古い日記を削除する。 */
  public insert(
    entry: NewDiaryEntry,
    opts?: { maxEntries?: number }
  ): DiaryEntry {
    const record: DiaryEntry = { ...entry, id: randomUUID() };
    // LokiJS の insertOne は失敗時 undefined を返すため、
    // 呼び出し側で常に取得できる形に正規化する
    const inserted = this.collection.insertOne(record) ?? record;
    this.enforceMaxEntries(opts?.maxEntries ?? 20);
    return inserted;
  }

  /** 保持期間内の日記を新しい順に取得する（プロンプト注入用）。 */
  public findRecent(opts?: {
    retentionHours?: number;
    limit?: number;
    now?: number;
  }): DiaryEntry[] {
    const cutoff =
      (opts?.now ?? Date.now()) -
      (opts?.retentionHours ?? 72) * (60 * 60 * 1000);
    return this.collection
      .chain()
      .find({ createdAt: { $gt: cutoff } })
      .simplesort('createdAt', true)
      .limit(opts?.limit ?? Number.MAX_SAFE_INTEGER)
      .data();
  }

  /** 保持上限を超えた古い日記を削除する。@returns 削除した件数。 */
  private enforceMaxEntries(maxEntries: number): number {
    if (maxEntries < 1) return 0;
    const all = this.collection.chain().simplesort('createdAt', true).data();
    const removable = all.slice(maxEntries);
    for (const entry of removable) {
      this.collection.remove(entry);
    }
    return removable.length;
  }

  /** 保持期間切れの日記を明示的に掃除する（定期ジョブ用）。@returns 削除した件数。 */
  public pruneOldEntries(retentionHours = 72, now = Date.now()): number {
    const cutoff = now - retentionHours * (60 * 60 * 1000);
    // 日記は履歴価値のみで、保持期間を過ぎたら参照されないため
    // 72h を日単位（DAY_MS）ではなく時間単位で判定する
    const old = this.collection.find({ createdAt: { $lte: cutoff } });
    for (const entry of old) {
      this.collection.remove(entry);
    }
    return old.length;
  }

  /** テスト・統計用の全件数。 */
  public count(): number {
    return this.collection.count();
  }
}
