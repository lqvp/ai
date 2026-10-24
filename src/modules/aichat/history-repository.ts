import type loki from 'lokijs';
import type { Base64File, ChatHistoryItem, TimelineContext } from './types.js';

/**
 * AIチャットの会話履歴1件分。
 * 「どのノート（またはチャット）に対する返信か」を表す。
 */
export type AiChatHist = {
  postId: string;
  createdAt: number;
  type: string;
  api?: string;
  history?: ChatHistoryItem[];
  friendName?: string;
  originalNoteId?: string;
  fromMention: boolean;
  grounding?: boolean;
  youtubeUrls?: string[];
  isChat?: boolean;
  chatUserId?: string;
  timelineContext?: TimelineContext;
  quotedFiles?: Base64File[];
};

/**
 * `aichatHist` コレクションへのアクセスをまとめる。
 *
 * 以前はモジュール内に `findOne({ ... })` が散在していたため、
 * 「どのキーで引いているか」が読み取りづらかった。
 * クエリの意味をここに集約する。
 */
export class ChatHistoryRepository {
  constructor(private readonly collection: loki.Collection<AiChatHist>) {}

  /** ノートIDで引く（返信先ノート・返信ノートのどちらでも） */
  public findByPostId(postId: string): AiChatHist | null {
    return (this.collection.findOne({ postId }) as AiChatHist | null) ?? null;
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

  public insert(record: AiChatHist): void {
    this.collection.insertOne(record);
  }

  public remove(record: AiChatHist): void {
    this.collection.remove(record);
  }
}
