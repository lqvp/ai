import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import { User, UserDetailed } from '@/misskey/user.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { UserFormatter } from '@/utils/user-formatter.js';

// 定数定義
const ACTIONS = {
  FOLLOW: 'follow',
  UNFOLLOW: 'unfollow',
} as const;

const KEYWORDS = {
  FOLLOW: ['フォロー', 'フォロバ', 'follow me'],
  MASTER_FOLLOW: ['follow'],
  MASTER_UNFOLLOW: ['unfollow'],
} as const;

// Master用ユーザーコマンドの型定義
interface MasterUserCommand {
  action: typeof ACTIONS.FOLLOW | typeof ACTIONS.UNFOLLOW;
  targetUsername: string;
  targetHost?: string; // undefined for local users
}

export default class extends Module {
  public readonly name = 'follow';

  @bindThis
  public install() {
    // 3時間に1回
    this.every(1000 * 60 * 60 * 3, this.unfollowNonFollowers, {
      immediate: true,
    });

    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
  private isMasterUser(msg: Message): boolean {
    return this.ai.relationship.isMaster(msg.user);
  }

  @bindThis
  private extractTargetMentions(
    text: string
  ): { username: string; host?: string }[] {
    const mentionPattern = /@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g;
    const matches = [...text.matchAll(mentionPattern)];
    const aiName = this.ai.account.username;

    return matches
      .map((match) => ({
        username: match[1],
        host: match[2] || undefined,
      }))
      .filter((mention) => !(mention.username === aiName && !mention.host));
  }

  @bindThis
  private parseMasterUserCommand(msg: Message): MasterUserCommand | null {
    if (!msg.text) return null;

    const text = msg.text.toLowerCase();
    let action: typeof ACTIONS.FOLLOW | typeof ACTIONS.UNFOLLOW | null = null;

    // アクション判定
    if (
      KEYWORDS.MASTER_FOLLOW.some((keyword) => text.includes(keyword)) &&
      !KEYWORDS.MASTER_UNFOLLOW.some((keyword) => text.includes(keyword))
    ) {
      action = ACTIONS.FOLLOW;
    } else if (
      KEYWORDS.MASTER_UNFOLLOW.some((keyword) => text.includes(keyword))
    ) {
      action = ACTIONS.UNFOLLOW;
    } else {
      return null;
    }

    // ターゲットユーザーを抽出
    const mentions = this.extractTargetMentions(msg.text);
    if (mentions.length === 0) return null;

    const target = mentions[0]; // 最初のメンションをターゲットとする

    return {
      action,
      targetUsername: target.username,
      targetHost: target.host,
    };
  }

  @bindThis
  private formatUserDisplay(username: string, host?: string): string {
    return `@${username}${host ? '@' + host : ''}`;
  }

  @bindThis
  private formatCommandResult(
    success: boolean,
    action: string,
    userDisplay: string
  ): string {
    if (success) {
      if (action === ACTIONS.FOLLOW) {
        return serifs.follow.success.follow(userDisplay);
      } else {
        return serifs.follow.success.unfollow(userDisplay);
      }
    } else {
      const actionText =
        action === ACTIONS.FOLLOW ? 'フォロー' : 'フォロー解除';
      return serifs.follow.error.apiFailed(userDisplay, actionText);
    }
  }

  @bindThis
  private async lookupUser(
    username: string,
    host?: string
  ): Promise<UserDetailed | null> {
    try {
      // ローカルユーザーの場合
      if (!host) {
        const user = await this.ai.api<UserDetailed>('users/show', {
          username: username,
        });
        return user;
      }

      // リモートユーザーの場合
      const user = await this.ai.api<UserDetailed>('users/show', {
        username: username,
        host: host,
      });
      return user;
    } catch (error) {
      this.log(
        `Failed to lookup user @${username}${host ? '@' + host : ''}: ${error}`
      );
      return null;
    }
  }

  @bindThis
  private async followUserByMaster(targetUser: UserDetailed): Promise<boolean> {
    try {
      this.log(
        `Attempting to follow user: ${UserFormatter.formatUserForLog(
          targetUser
        )} (ID: ${targetUser.id})`
      );

      // 既にフォロー中かチェック
      if (targetUser.isFollowing) {
        this.log(
          `User ${UserFormatter.formatUserForLog(
            targetUser
          )} is already being followed`
        );
      }

      await this.ai.api('following/create', {
        userId: targetUser.id,
      });
      this.log(
        `Master forced follow: ${UserFormatter.formatUserForLog(targetUser)}`
      );
      return true;
    } catch (error) {
      this.log(`Failed to follow user by master: ${error}`);
      if (error instanceof Error) {
        this.log(`Error details: ${error.message}`);
      }
      return false;
    }
  }

  @bindThis
  private async unfollowUserByMaster(
    targetUser: UserDetailed
  ): Promise<boolean> {
    try {
      this.log(
        `Attempting to unfollow user: ${UserFormatter.formatUserForLog(
          targetUser
        )} (ID: ${targetUser.id})`
      );

      // フォローしているかチェック
      if (!targetUser.isFollowing) {
        this.log(
          `User ${UserFormatter.formatUserForLog(
            targetUser
          )} is not being followed`
        );
      }

      await this.ai.api('following/delete', {
        userId: targetUser.id,
      });
      this.log(
        `Master forced unfollow: ${UserFormatter.formatUserForLog(targetUser)}`
      );
      return true;
    } catch (error) {
      this.log(`Failed to unfollow user by master: ${error}`);
      if (error instanceof Error) {
        this.log(`Error details: ${error.message}`);
      }
      return false;
    }
  }

  @bindThis
  private async executeUserCommand(
    command: MasterUserCommand,
    msg: Message
  ): Promise<boolean> {
    // ユーザー検索
    const targetUser = await this.lookupUser(
      command.targetUsername,
      command.targetHost
    );
    if (!targetUser) {
      const userDisplay = this.formatUserDisplay(
        command.targetUsername,
        command.targetHost
      );
      await msg.reply(serifs.follow.error.userNotFound(userDisplay));
      return false;
    }

    // アクション実行
    let success = false;

    if (command.action === ACTIONS.FOLLOW) {
      success = await this.followUserByMaster(targetUser);
    } else {
      success = await this.unfollowUserByMaster(targetUser);
    }

    // 結果通知
    const userDisplay = this.formatUserDisplay(
      command.targetUsername,
      command.targetHost
    );
    const resultMessage = this.formatCommandResult(
      success,
      command.action,
      userDisplay
    );
    await msg.reply(resultMessage);

    return success;
  }

  @bindThis
  private async mentionHook(msg: Message) {
    const allowedHosts = config.followAllowedHosts || [];
    const followExcludeInstances = config.followExcludeInstances || [];

    // Master用コマンド処理
    if (this.isMasterUser(msg)) {
      const command = this.parseMasterUserCommand(msg);
      if (command) {
        this.log(
          `Master command detected: ${command.action} @${
            command.targetUsername
          }${command.targetHost ? '@' + command.targetHost : ''}`
        );
        await this.executeUserCommand(command, msg);
        return { reaction: 'like' };
      }
    }

    // 既存の一般ユーザー向けフォロー処理
    if (
      msg.text &&
      KEYWORDS.FOLLOW.some((keyword) => msg.text.includes(keyword))
    ) {
      // ユーザーの詳細情報を取得
      let detailedUser: UserDetailed;
      try {
        detailedUser = (await this.ai.api('users/show', {
          userId: msg.userId,
        })) as UserDetailed;
      } catch (error) {
        console.error('Failed to fetch user details:', error);
        return false;
      }

      // console.log('User host:', detailedUser.host);
      // console.log('User following status:', detailedUser.isFollowing);

      if (
        !detailedUser.isFollowing &&
        (detailedUser.host == null ||
          detailedUser.host === '' ||
          this.shouldFollowUser(
            detailedUser.host,
            allowedHosts,
            followExcludeInstances
          ))
      ) {
        try {
          await this.ai.api('following/create', {
            userId: msg.userId,
          });
          return {
            reaction: msg.friend.love >= 0 ? 'like' : null,
          };
        } catch (error) {
          console.error('Failed to follow user:', error);
          return false;
        }
      } else if (!detailedUser.isFollowing) {
        await msg.reply(serifs.follow.error.permissionDenied);
        return {
          reaction: msg.friend.love >= 0 ? 'hmm' : null,
        };
      }
    } else {
      return false;
    }
    return false;
  }

  /**
   * リモートユーザーをフォローすべきかどうかを判定する
   * @param host ユーザーのホスト
   * @param allowedHosts 許可されたホストのリスト
   * @param excludedHosts 除外されたホストのリスト
   * @returns フォローすべき場合はtrue、そうでない場合はfalse
   */
  private shouldFollowUser(
    host: string,
    allowedHosts: string[],
    excludedHosts: string[]
  ): boolean {
    // followAllowedHostsが存在する場合、followExcludeInstancesを無視する
    if (allowedHosts.length > 0) {
      return this.isHostAllowed(host, allowedHosts);
    }
    // followAllowedHostsが存在しない場合、followExcludeInstancesを適用する
    return !this.isHostExcluded(host, excludedHosts);
  }

  /**
   * ホストが許可されたホストリストに含まれるかどうかを判定する
   * @param host ユーザーのホスト
   * @param allowedHosts 許可されたホストのリスト
   * @returns 許可された場合はtrue、そうでない場合はfalse
   */
  private isHostAllowed(host: string, allowedHosts: string[]): boolean {
    for (const allowedHost of allowedHosts) {
      if (allowedHost.startsWith('*')) {
        const domain = allowedHost.slice(1);
        if (host.endsWith(domain)) {
          return true;
        }
      } else if (host === allowedHost) {
        return true;
      }
    }
    return false;
  }

  /**
   * ホストが除外されたホストリストに含まれるかどうかを判定する
   * @param host ユーザーのホスト
   * @param excludedHosts 除外されたホストのリスト
   * @returns 除外された場合はtrue、そうでない場合はfalse
   */
  private isHostExcluded(host: string, excludedHosts: string[]): boolean {
    for (const excludedHost of excludedHosts) {
      if (excludedHost.startsWith('*')) {
        const domain = excludedHost.slice(1);
        if (host.endsWith(domain)) {
          return true;
        }
      } else if (host === excludedHost) {
        return true;
      }
    }
    return false;
  }

  @bindThis
  private async unfollowNonFollowers() {
    this.log('Unfollowing non-followers...');

    try {
      const following = await this.fetchAllUsers('users/following');
      this.log(
        `Fetched ${following.length} following users: ${following
          .map((u) => UserFormatter.formatUserForLog(u))
          .join(', ')}`
      );

      const followers = await this.fetchAllUsers('users/followers');
      this.log(
        `Fetched ${followers.length} followers: ${followers
          .map((u) => UserFormatter.formatUserForLog(u))
          .join(', ')}`
      );

      const followerIds = followers.map((u) => u.id);
      this.log(`Follower IDs: ${followerIds.join(', ')}`);

      const usersToUnfollow = following.filter((u) => {
        const isFollowedByBot = followerIds.includes(u.id);
        if (!isFollowedByBot) {
          this.log(
            `User ${UserFormatter.formatUserForLog(
              u
            )} is followed by bot but not following back.`
          );
        }
        return !isFollowedByBot;
      });
      this.log(
        `Found ${usersToUnfollow.length} users to unfollow: ${usersToUnfollow
          .map((u) => UserFormatter.formatUserForLog(u))
          .join(', ')}`
      );

      if (usersToUnfollow.length === 0) {
        this.log('No users to unfollow.');
        return;
      }

      this.log(`Unfollowing ${usersToUnfollow.length} users...`);

      for (const user of usersToUnfollow) {
        try {
          await this.ai.api('following/delete', { userId: user.id });
          this.log(`Unfollowed ${UserFormatter.formatUserForLog(user)}`);
        } catch (error) {
          console.error(`Failed to unfollow @${user.username}:`, error);
        }
      }

      this.log('Unfollowing process finished.');
    } catch (error) {
      console.error('Failed to unfollow non-followers:', error);
    }
  }

  private async fetchAllUsers(
    endpoint: 'users/following' | 'users/followers'
  ): Promise<User[]> {
    let allUsers: User[] = [];
    let untilId: string | undefined = undefined;

    while (true) {
      const responseItems = await this.ai.api<
        | { id: string; followee: User; follower?: never }[]
        | { id: string; follower: User; followee?: never }
      >(endpoint, {
        userId: this.ai.account.id,
        limit: 100,
        untilId: untilId,
      });

      if (!responseItems || responseItems.length === 0) {
        break;
      }

      let extractedUsers: User[];
      if (endpoint === 'users/following') {
        extractedUsers = responseItems
          .map((item) => (item as { followee: User }).followee)
          .filter((user) => user && user.id);
      } else {
        // users/followers
        extractedUsers = responseItems
          .map((item) => (item as { follower: User }).follower)
          .filter((user) => user && user.id);
      }
      allUsers = allUsers.concat(extractedUsers);

      if (responseItems.length < 100) {
        // Optimization: if less than limit, no more pages
        break;
      }
      untilId = responseItems[responseItems.length - 1].id;
    }

    return allUsers;
  }
}
