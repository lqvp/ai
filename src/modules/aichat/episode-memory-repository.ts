import { randomUUID } from 'node:crypto';
import type loki from 'lokijs';
import type { EpisodeMemory, NewEpisodeMemory } from './episode-memory.js';

/** アーカイブ対象の経過日数（90日）。未参照かつ低重要度の記憶だけ対象。 */
const ARCHIVE_AFTER_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * `aichatMemory` コレクションへのアクセスをまとめる。
 * ChatHistoryRepository と同じく、クエリの意味をここに集約する。
 */
export class EpisodeMemoryRepository {
  constructor(private readonly collection: loki.Collection<EpisodeMemory>) {}

  /** 記憶を1件挿入する。IDはここで採番する。 */
  public insert(memory: NewEpisodeMemory): EpisodeMemory {
    const record: EpisodeMemory = { ...memory, id: randomUUID() };
    // LokiJS の insertOne は失敗時 undefined を返すため、
    // 呼び出し側で常に取得できる形に正規化する
    return this.collection.insertOne(record) ?? record;
  }

  /** ユーザーの有効な記憶を取得する（アーカイブ済み・superseded 済みは除外）。 */
  public findByUserId(
    userId: string,
    opts?: { minImportance?: number }
  ): EpisodeMemory[] {
    return this.collection
      .find({ userId })
      .filter(
        (memory) =>
          memory.archivedAt == null &&
          memory.supersededBy == null &&
          memory.importance >= (opts?.minImportance ?? 1)
      );
  }

  /** ユーザーの記憶件数（上限制限の判定用。アーカイブ済みも含む生件数）。 */
  public countByUserId(userId: string): number {
    return this.collection.find({ userId }).length;
  }

  /** 既存の記憶を新しい記憶で上書き済みとマークする。 */
  public markSuperseded(id: string, supersededById: string): void {
    const doc = this.collection.findOne({ id }) as EpisodeMemory | null;
    if (doc == null) return;
    doc.supersededBy = supersededById;
    this.collection.update(doc);
  }

  /**
   * アーカイブポリシー: 90日以上古く重要度2以下の記憶を archivedAt 付きで
   * フラグする。物理削除せずフラグのみなのは、誤ったアーカイブを
   * 復元できるようにするため。
   * @returns アーカイブした件数
   */
  public pruneOldMemories(now = Date.now()): number {
    const cutoff = now - ARCHIVE_AFTER_DAYS * DAY_MS;
    const targets = this.collection
      .find({ createdAt: { $lt: cutoff } })
      .filter((m) => m.importance <= 2 && m.archivedAt == null);
    for (const memory of targets) {
      memory.archivedAt = now;
      this.collection.update(memory);
    }
    return targets.length;
  }
}
