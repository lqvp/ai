import { bindThis } from '@/decorators.js';
import Friend from '@/friend.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { getZonedParts, todayKey } from '@/services/clock.js';

export default class extends Module {
  public readonly name = 'valentine';

  @bindThis
  public install() {
    this.every(1000 * 60 * 3, this.crawleValentine, { immediate: true });

    return {};
  }

  /**
   * チョコ配り
   */
  @bindThis
  private crawleValentine() {
    const now = getZonedParts();

    const isValentine = now.month === 2 && now.day === 14;
    if (!isValentine) return;

    const date = todayKey();

    const friends = this.ai.repos.friends.all();

    friends.forEach((f) => {
      const friend = new Friend(this.ai, { doc: f });

      // 親愛度が5以上必要
      if (friend.love < 5) return;

      const data = friend.getPerModulesData(this);

      if (data.lastChocolated == date) return;

      data.lastChocolated = date;
      friend.setPerModulesData(this, data);

      const text = serifs.valentine.chocolateForYou(friend.name);

      this.ai.sendMessage(friend.userId, {
        text: text,
      });
    });
  }
}
