import type loki from 'lokijs';
import { TIMEOUT_TIME } from './constants.js';
import type { Base64File, ChatHistoryItem, TimelineContext } from './types.js';

/**
 * AIチャットの会話セッション履歴。
 * セッションID単位で継続状態と期限(expiresAt)を管理する。
 */
export type AiChatHist = {
  sessionId?: string;
  postId: string;
  latestPostId?: string;
  postIds?: string[];
  createdAt: number;
  updatedAt?: number;
  expiresAt?: number;
  type: string;
  api?: string;
  history?: ChatHistoryItem[];
  friendName?: string;
  originalNoteId?: string;
  fromMention: boolean;
  isFallbackMention?: boolean;
  grounding?: boolean;
  youtubeUrls?: string[];
  isChat?: boolean;
  chatUserId?: string;
  ownerUserId?: string;
  followUpUsed?: boolean;
  timelineContext?: TimelineContext;
  quotedFiles?: Base64File[];
};

/**
 * `aichatHist` コレクションへのアクセスをまとめる。
 */
export class ChatHistoryRepository {
  constructor(private readonly collection: loki.Collection<AiChatHist>) {}

  public findBySessionId(sessionId: string): AiChatHist | null {
    return (
      (this.collection.findOne({ sessionId }) as AiChatHist | null) ?? null
    );
  }

  /** ノートIDで引く（最新投稿またはスライディングウィンドウ内） */
  public findByPostId(postId: string): AiChatHist | null {
    const direct = this.collection.findOne({ postId }) as AiChatHist | null;
    if (direct) return direct;
    return this.all().find((doc) => doc.postIds?.includes(postId)) ?? null;
  }

  /** 複数のノートIDのうち、履歴に存在するものを1件返す */
  public findAnyByPostIds(postIds: readonly string[]): AiChatHist | null {
    for (const postId of postIds) {
      const found = this.findByPostId(postId);
      if (found) return found;
    }
    return null;
  }

  /** 元ノートID（藍が返信した相手）で引く */
  public findByOriginalNoteId(noteId: string): AiChatHist | null {
    return (
      (this.collection.findOne({
        originalNoteId: noteId,
      }) as AiChatHist | null) ?? null
    );
  }

  /** チャット（ダイレクトメッセージ）の継続中の会話を引く */
  public findChat(chatUserId: string): AiChatHist | null {
    return (
      (this.collection.findOne({
        isChat: true,
        chatUserId,
      }) as AiChatHist | null) ?? null
    );
  }

  public findExpired(now: number = Date.now()): AiChatHist[] {
    return this.all().filter((doc) => {
      const expiresAt = doc.expiresAt ?? doc.createdAt + TIMEOUT_TIME;
      return now >= expiresAt;
    });
  }

  public all(): AiChatHist[] {
    return this.collection.find() as AiChatHist[];
  }

  public insert(record: AiChatHist): void {
    this.collection.insertOne(record);
  }

  public update(record: AiChatHist): void {
    if ((record as { $loki?: number }).$loki != null) {
      this.collection.update(record);
      return;
    }
    const existing = record.sessionId
      ? this.findBySessionId(record.sessionId)
      : null;
    if (existing) {
      Object.assign(existing, record);
      this.collection.update(existing);
      return;
    }
    this.collection.insertOne(record);
  }

  public remove(record: AiChatHist): void {
    this.collection.remove(record);
  }
}
