import { bindThis } from '@/decorators.js';
import Friend from '@/friend.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { monthDayKey } from '@/services/clock.js';

export default class extends Module {
  public readonly name = 'birthday';

  @bindThis
  public install() {
    this.every(1000 * 60 * 3, this.crawleBirthday, { immediate: true });

    return {};
  }

  /**
   * 誕生日のユーザーがいないかチェック(いたら祝う)
   */
  @bindThis
  private crawleBirthday() {
    // Misskeyの誕生日は 2018-06-16 のような形式
    const today = monthDayKey();

    const birthFriends = this.ai.repos.friends.findBornOn(today);

    birthFriends.forEach((f) => {
      const friend = new Friend(this.ai, { doc: f });

      // 親愛度が3以上必要
      if (friend.love < 3) return;

      const data = friend.getPerModulesData(this);

      if (data.lastBirthdayChecked == today) return;

      data.lastBirthdayChecked = today;
      friend.setPerModulesData(this, data);

      const text = serifs.birthday.happyBirthday(friend.name);

      this.ai.sendMessage(friend.userId, {
        text: text,
      });
    });
  }
}
