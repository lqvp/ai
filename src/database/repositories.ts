import type loki from 'lokijs';
import type { FriendDoc } from '@/friend.js';

export type { FriendDoc };

export type ContextDoc = {
  isChat: boolean;
  noteId?: string;
  userId?: string;
  module: string;
  key: string | null;
  data?: any;
};

export type TimerDoc = {
  id: string;
  module: string;
  insertedAt: number;
  delay: number;
  data?: any;
};

export type ModuleDataDoc = {
  module: string;
  data: Record<string, any>;
};

/**
 * friends コレクションへのアクセスをまとめる。
 * `userId` の一意性はリポジトリ側で保証する。
 */
export class FriendRepository {
  constructor(private readonly collection: loki.Collection<FriendDoc>) {}

  public findById(userId: string): FriendDoc | null {
    return (this.collection.findOne({ userId }) as FriendDoc | null) ?? null;
  }

  public upsert(user: FriendDoc['user']): FriendDoc {
    const existing = this.findById(user.id);
    if (existing) {
      existing.user = { ...existing.user, ...user };
      this.collection.update(existing);
      return existing;
    }

    const doc: FriendDoc = { userId: user.id, user };
    const inserted = this.collection.insertOne(doc) as FriendDoc | null;
    if (inserted == null) {
      throw new Error(`Failed to insert friend doc for ${user.id}`);
    }
    return inserted;
  }

  public save(doc: FriendDoc): void {
    this.collection.update(doc);
  }

  public findByTransferCode(code: string): FriendDoc | null {
    return (
      (this.collection.findOne({
        transferCode: code,
      }) as FriendDoc | null) ?? null
    );
  }

  /** 誕生日が `MM-DD` で終わる友達を探す（Misskey の誕生日は `YYYY-MM-DD`） */
  public findBornOn(monthDay: string): FriendDoc[] {
    const pattern = new RegExp(`-${monthDay}$`);
    return this.collection.find({
      'user.birthday': { $regex: pattern },
    } as any) as FriendDoc[];
  }

  public all(): FriendDoc[] {
    return this.collection.find();
  }
}

export class ContextRepository {
  constructor(private readonly collection: loki.Collection<ContextDoc>) {}

  public findForNote(noteId: string | null | undefined): ContextDoc | null {
    if (noteId == null) return null;
    return this.collection.findOne({
      isChat: false,
      noteId,
    }) as ContextDoc | null;
  }

  public findForChat(userId: string): ContextDoc | null {
    return this.collection.findOne({
      isChat: true,
      userId,
    }) as ContextDoc | null;
  }

  public insert(doc: ContextDoc): void {
    this.collection.insertOne(doc);
  }

  /**
   * 返信待ちコンテキストを登録する。
   *
   * 1つのノート（または1人のチャット相手）に対して待ち受けは1つだけなので、
   * 同じ宛先の古いコンテキストは置き換える。
   * 以前は重複が残り、`findOne` がどれを返すか不定だった。
   */
  public subscribe(doc: ContextDoc): void {
    if (doc.isChat) {
      if (doc.userId != null) {
        this.collection.findAndRemove({ isChat: true, userId: doc.userId });
      }
    } else if (doc.noteId != null) {
      this.collection.findAndRemove({ isChat: false, noteId: doc.noteId });
    }

    this.insert(doc);
  }

  public remove(doc: ContextDoc): void {
    this.collection.remove(doc);
  }

  public removeByKey(module: string, key: string | null): void {
    this.collection.findAndRemove({ module, key });
  }

  public removeByModule(module: string): number {
    const docs = this.collection.find({ module });
    for (const doc of docs) this.collection.remove(doc);
    return docs.length;
  }
}

export class TimerRepository {
  constructor(private readonly collection: loki.Collection<TimerDoc>) {}

  public insert(timer: TimerDoc): void {
    this.collection.insertOne(timer);
  }

  public all(): TimerDoc[] {
    return this.collection.find();
  }

  public due(now: number = Date.now()): TimerDoc[] {
    return this.collection
      .find()
      .filter((timer) => now - (timer.insertedAt + timer.delay) >= 0);
  }

  public remove(timer: TimerDoc): void {
    this.collection.remove(timer);
  }
}

export class ModuleDataRepository {
  constructor(private readonly collection: loki.Collection<ModuleDataDoc>) {}

  public findByModule(module: string): ModuleDataDoc | null {
    return (
      (this.collection.findOne({
        module,
      }) as ModuleDataDoc | null) ?? null
    );
  }

  public ensure(module: string): ModuleDataDoc {
    const existing = this.findByModule(module);
    if (existing) return existing;

    const inserted = this.collection.insertOne({
      module,
      data: {},
    }) as ModuleDataDoc | null;

    if (inserted == null) {
      throw new Error(`Failed to insert module data for ${module}`);
    }
    return inserted;
  }

  public save(doc: ModuleDataDoc): void {
    this.collection.update(doc);
  }
}

export type Repositories = {
  friends: FriendRepository;
  contexts: ContextRepository;
  timers: TimerRepository;
  moduleData: ModuleDataRepository;
};
