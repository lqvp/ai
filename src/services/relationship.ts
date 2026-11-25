import type APIClient from '@/api/APIClient.js';
import type { User } from '@/misskey/types.js';

type RelationResult = { isFollowing?: boolean };

/**
 * フォロー関係とマスターユーザー判定をまとめる。
 * 以前は aichat / imagen / veo / follow / info に同じ実装が散在していた。
 */
export class RelationshipService {
  private readonly api: Pick<APIClient, 'api'>;
  private readonly accountId: string;
  private readonly masterUsername?: string;
  private readonly masterUserId?: string;

  constructor(
    api: Pick<APIClient, 'api'>,
    accountId: string,
    masterUsername?: string,
    masterUserId?: string
  ) {
    this.api = api;
    this.accountId = accountId;
    this.masterUsername = masterUsername;
    this.masterUserId = masterUserId;
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
   * `master` / `masterUserId` 設定のローカルユーザーかどうか。
   */
  public isMaster(
    user: (Pick<User, 'username' | 'host'> & { id?: string }) | null | undefined
  ): boolean {
    if (!user || user.host != null) return false;
    const configuredId = this.masterUserId?.trim();
    if (configuredId) {
      return user.id === configuredId;
    }
    if (!this.masterUsername) return false;
    return user.username === this.masterUsername;
  }
}
