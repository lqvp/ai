import type APIClient from '@/api/APIClient.js';
import type Friend from '@/friend.js';

/**
 * リアクション作成を1箇所に集約する。
 * 以前は ai.ts / emoji-react / imagen / ping / veo / welcome に同じ呼び出しがあった。
 */
export class ReactionService {
  private readonly api: Pick<APIClient, 'api'>;
  private readonly canReact: (friend: Friend | null) => boolean;

  constructor(
    api: Pick<APIClient, 'api'>,
    canReact: (friend: Friend | null) => boolean
  ) {
    this.api = api;
    this.canReact = canReact;
  }

  /**
   * リアクション設定を尊重してリアクションする。
   * 失敗しても呼び出し元の処理を止めない。
   */
  public async react(
    noteId: string,
    reaction: string | null | undefined,
    friend: Friend | null = null
  ): Promise<boolean> {
    if (!reaction) return false;
    if (!this.canReact(friend)) return false;

    try {
      await this.api.api('notes/reactions/create', { noteId, reaction });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 設定を無視してリアクションする（絵文字リアクションなど、
   * 呼び出し側が事前に判定済みのケース）。
   */
  public async reactForce(noteId: string, reaction: string): Promise<boolean> {
    try {
      await this.api.api('notes/reactions/create', { noteId, reaction });
      return true;
    } catch {
      return false;
    }
  }
}
