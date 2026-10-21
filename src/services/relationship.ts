import type APIClient from '@/api/APIClient.js';
import type { User } from '@/misskey/user.js';

type RelationResult = { isFollowing?: boolean };

/**
 * フォロー関係とマスターユーザー判定をまとめる。
 * 以前は aichat / imagen / veo / follow / info に同じ実装が散在していた。
 */
export class RelationshipService {
  private readonly api: Pick<APIClient, 'api'>;
  private readonly accountId: string;
  private readonly masterUsername?: string;

  constructor(
    api: Pick<APIClient, 'api'>,
    accountId: string,
    masterUsername?: string
  ) {
    this.api = api;
    this.accountId = accountId;
    this.masterUsername = masterUsername;
  }

  /**
   * 自分自身は常に true。API 失敗時は安全側に倒して false。
   */
  public async isFollowing(userId: string): Promise<boolean> {
    if (userId === this.accountId) return true;

    try {
      const relation = await this.api.api<RelationResult[]>('users/relation', {
        userId,
      });
      return relation?.[0]?.isFollowing === true;
    } catch {
      return false;
    }
  }

  /**
   * `master` 設定のローカルユーザーかどうか。
   */
  public isMaster(
    user: Pick<User, 'username' | 'host'> | null | undefined
  ): boolean {
    if (!user || !this.masterUsername) return false;
    return user.username === this.masterUsername && user.host == null;
  }
}
