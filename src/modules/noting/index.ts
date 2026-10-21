import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { genItem } from '@/vocabulary.js';

export default class extends Module {
  public readonly name = 'noting';

  @bindThis
  public install() {
    if (config.notingEnabled === false) return false;

    this.every(1000 * 60 * 10, () => {
      if (Math.random() < 0.04) {
        this.post();
      }
    });

    return {};
  }

  @bindThis
  private post() {
    const notes = [
      ...serifs.noting.notes,
      () => {
        const item = genItem();
        return serifs.noting.want(item);
      },
      () => {
        const item = genItem();
        return serifs.noting.see(item);
      },
      () => {
        const item = genItem();
        return serifs.noting.expire(item);
      },
    ];

    const note = notes[Math.floor(Math.random() * notes.length)];

    // TODO: 季節に応じたセリフ

    this.ai.post({
      text: typeof note === 'function' ? note() : note,
    });
  }
}
