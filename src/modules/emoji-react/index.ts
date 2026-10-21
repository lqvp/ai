import { parse } from 'twemoji-parser';
import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import type { Note } from '@/misskey/note.js';
import Module from '@/module.js';
import Stream from '@/stream.js';
import includes from '@/utils/includes.js';
import { sleep } from '@/utils/sleep.js';

export default class extends Module {
  public readonly name = 'emoji-react';

  private htl!: ReturnType<Stream['useSharedConnection']>;

  @bindThis
  public install() {
    this.htl = this.ai.connection.useSharedConnection('homeTimeline');
    this.htl.on('note', this.onNote);

    return {};
  }

  protected onDispose(): void {
    this.htl?.dispose();
  }

  @bindThis
  private async onNote(note: Note) {
    if (note.reply != null) return;
    if (note.text == null) return;
    if (note.text.includes('@')) return; // (自分または他人問わず)メンションっぽかったらreject
    if (note.userId === this.ai.account.id) return;

    // リアクション設定チェック
    const friend = this.ai.lookupFriend(note.userId);
    if (!this.ai.shouldReaction(friend)) return;

    const react = async (reaction: string, immediate = false) => {
      if (!immediate) {
        await sleep(1500);
      }
      await this.ai.reactions.reactForce(note.id, reaction);
    };

    // カスタム絵文字の厳密な検出: :emoji_name: のみ許可（英数字・_・+・-）
    const customEmojis = note.text.match(
      /(?<=^|\s):([a-zA-Z0-9_+\-]+?):(?=\s|$)/g
    );
    if (customEmojis) {
      // カスタム絵文字が複数種類ある場合はキャンセル
      if (!customEmojis.every((val, _, arr) => val === arr[0])) return;

      this.log(`Custom emoji detected - ${customEmojis[0]}`);

      return react(customEmojis[0]);
    }

    const emojis = parse(note.text).map((x) => x.text);
    if (emojis.length > 0) {
      // 絵文字が複数種類ある場合はキャンセル
      if (!emojis.every((val, _, arr) => val === arr[0])) return;

      this.log(`Emoji detected - ${emojis[0]}`);

      let reaction = emojis[0];

      switch (reaction) {
        case '✊':
          return react('🖐', true);
        case '✌':
          return react('✊', true);
        case '🖐':
        case '✋':
          return react('✌', true);
      }

      return react(reaction);
    }

    if (includes(note.text, ['ぴざ'])) return react('🍕');
    if (includes(note.text, ['ぷりん'])) return react('🍮');
    if (includes(note.text, ['寿司', 'sushi']) || note.text === 'すし')
      return react('🍣');
    if (includes(note.text, ['らーめん', 'ramen'])) return react('🍜');
    if (includes(note.text, ['かれー', 'curry'])) return react('🍛');
    if (includes(note.text, ['はんばーがー', 'hamburger'])) return react('🍔');
    if (includes(note.text, ['ほっとけーき', 'hotcake'])) return react('🥞');
    if (includes(note.text, ['ぱすた', 'pasta'])) return react('🍝');
    if (includes(note.text, ['けーき', 'cake'])) return react('🍰');
    if (includes(note.text, ['たこ', 'octopus'])) return react('🐙');
    if (includes(note.text, ['ねこ', 'cat'])) return react('😺');
    if (includes(note.text, ['いぬ', 'dog'])) return react('🐶');

    if (config.aiName && includes(note.text, config.aiName)) return react('🙌');
  }
}
