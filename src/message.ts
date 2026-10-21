import chalk from 'chalk';
import 藍 from '@/ai.js';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Friend from '@/friend.js';
import type { Note } from '@/misskey/note.js';
import type { User } from '@/misskey/user.js';
import includes from '@/utils/includes.js';
import or from '@/utils/or.js';
import { sleep } from '@/utils/sleep.js';

export type ChatMessage = {
  id: string;
  fromUser: User;
  fromUserId: string;
  text: string;
};

type NoteMessage = Note & {
  text: string;
  replyId: string | null;
  renoteId: string | null;
};

export type MessageSource =
  | { kind: 'note'; data: Note }
  | { kind: 'chat'; data: ChatMessage };

export type ReplyOptions = {
  file?: { id: string } | null;
  cw?: string;
  renote?: string;
  immediate?: boolean;
};

const USER_CACHE_TTL_MS = 5 * 60 * 1000;
const USER_CACHE_MAX = 500;

const userCache = new Map<string, { user: User; fetchedAt: number }>();

function getCachedUser(userId: string): User | null {
  const entry = userCache.get(userId);
  if (!entry) return null;
  if (Date.now() - entry.fetchedAt > USER_CACHE_TTL_MS) {
    userCache.delete(userId);
    return null;
  }
  return entry.user;
}

function setCachedUser(user: User): void {
  if (userCache.size >= USER_CACHE_MAX) {
    const oldest = userCache.keys().next().value;
    if (oldest !== undefined) userCache.delete(oldest);
  }
  userCache.set(user.id, { user, fetchedAt: Date.now() });
}

export default class Message {
  private readonly ai: 藍;
  private readonly source: MessageSource;
  public readonly isChat: boolean;
  public friend: Friend;

  private get note(): NoteMessage {
    if (this.source.kind !== 'note') {
      throw new Error('This message is a chat message, not a note');
    }
    return this.source.data as NoteMessage;
  }

  private get chat(): ChatMessage {
    if (this.source.kind !== 'chat') {
      throw new Error('This message is a note, not a chat message');
    }
    return this.source.data;
  }

  public get id(): string {
    return this.source.kind === 'chat' ? this.chat.id : this.note.id;
  }

  public get user(): User {
    return this.source.kind === 'chat' ? this.chat.fromUser : this.note.user;
  }

  public get userId(): string {
    return this.source.kind === 'chat'
      ? this.chat.fromUserId
      : this.note.userId;
  }

  /**
   * ノートの本文は null になりうる（CWのみ、ファイルのみ等）。
   * 型は既存コードとの互換のため string のままだが、実行時は null を返しうる。
   */
  public get text(): string {
    return this.source.kind === 'chat'
      ? this.chat.text
      : (this.note.text as string);
  }

  /**
   * 本文が存在するかどうかを明示的に判定する。
   */
  public hasText(): boolean {
    return this.text != null;
  }

  public get quoteId(): string | null {
    return this.source.kind === 'chat' ? null : this.note.renoteId;
  }

  public get replyId(): string | null {
    return this.source.kind === 'chat' ? null : this.note.replyId;
  }

  public get visibility(): string | undefined {
    return this.source.kind === 'chat' ? undefined : this.note.visibility;
  }

  /**
   * メンション部分を除いたテキスト本文
   */
  public get extractedText(): string {
    if (this.text == null) return '';

    const host = new URL(config.host).host.replace(/\./g, '\\.');
    return (this.text as string)
      .replace(new RegExp(`^@${this.ai.account.username}@${host}\\s`, 'i'), '')
      .replace(new RegExp(`^@${this.ai.account.username}\\s`, 'i'), '')
      .trim();
  }

  constructor(ai: 藍, chatMessageOrNote: any, isChat: boolean) {
    this.ai = ai;
    this.isChat = isChat;
    this.source = isChat
      ? { kind: 'chat', data: chatMessageOrNote as ChatMessage }
      : { kind: 'note', data: chatMessageOrNote as Note };

    this.friend = new Friend(ai, { user: this.user });

    // メッセージなどに付いているユーザー情報は省略されている場合があるので
    // 完全なユーザー情報を持ってくる。短時間のキャッシュで連投時のAPI呼び出しを抑える。
    const cached = getCachedUser(this.userId);
    if (cached) {
      this.friend.updateUser(cached);
    } else {
      this.ai
        .api<User>('users/show', {
          userId: this.userId,
        })
        .then((user) => {
          setCachedUser(user);
          this.friend.updateUser(user);
        })
        .catch((err) => {
          this.ai.log(
            `Failed to fetch user details for ${this.userId}: ${String(err)}`
          );
        });
    }
  }

  @bindThis
  public async reply(text: string | null, opts?: ReplyOptions): Promise<any> {
    if (text == null) return;

    this.ai.log(`>>> Sending reply to ${chalk.underline(this.id)}`);

    if (!opts?.immediate) {
      await sleep(2000);
    }

    if (this.source.kind === 'chat') {
      return await this.ai.sendMessage(this.chat.fromUserId, {
        text: text,
        fileId: opts?.file?.id,
      });
    }

    const note = this.note;
    const postData = {
      replyId: note.id,
      visibility: note.visibility,
      visibleUserIds: note.visibleUserIds,
      text: text,
      fileIds: opts?.file ? [opts.file.id] : undefined,
      cw: opts?.cw,
      renoteId: opts?.renote,
    };

    // 元の投稿の公開範囲を維持して返信する
    return await this.ai.post(postData);
  }

  @bindThis
  public includes(words: string[]): boolean {
    if (this.text == null) return false;
    return includes(this.text, words);
  }

  @bindThis
  public or(words: (string | RegExp)[]): boolean {
    if (this.text == null) return false;
    return or(this.text, words);
  }
}
