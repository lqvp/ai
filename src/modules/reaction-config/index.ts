import { bindThis } from '@/decorators.js';
import Friend from '@/friend.js';
import Message from '@/message.js';
import Module from '@/module.js';

export default class extends Module {
  public readonly name = 'reaction-config';

  @bindThis
  public install() {
    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.includes(['reaction'])) return false;

    const text = msg.extractedText.toLowerCase();

    // 状態確認
    if (text.includes('status')) {
      const enabled = this.isReactionEnabled(msg.friend);
      msg.reply(`リアクション機能: ${enabled ? '有効' : '無効'}`);
      return true;
    }

    // 設定変更 - 単語単位での判定
    const words = text.split(/\s+/);

    const enableWords = new Set(['true', 'on', 'enable', 'オン']);
    if (words.some((word) => enableWords.has(word))) {
      this.setReactionEnabled(msg.friend, true);
      msg.reply('リアクション機能を有効にしました');
      return true;
    }

    const disableWords = new Set(['false', 'off', 'disable', 'オフ']);
    if (words.some((word) => disableWords.has(word))) {
      this.setReactionEnabled(msg.friend, false);
      msg.reply('リアクション機能を無効にしました');
      return true;
    }

    return false;
  }

  @bindThis
  public isReactionEnabled(friend: Friend): boolean {
    const userData = friend.getPerModulesData(this);
    return userData.autoReactionEnabled !== false; // デフォルト true
  }

  @bindThis
  private setReactionEnabled(friend: Friend, enabled: boolean) {
    const userData = friend.getPerModulesData(this);
    userData.autoReactionEnabled = enabled;
    friend.setPerModulesData(this, userData);
  }
}
