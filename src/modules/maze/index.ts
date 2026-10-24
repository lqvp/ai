import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import type { DriveFile } from '@/misskey/drive-file.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { nowHour, todayKey } from '@/services/clock.js';
import { genMaze } from './gen-maze.js';
import { renderMaze } from './render-maze.js';

export default class extends Module {
  public readonly name = 'maze';

  @bindThis
  public install() {
    if (!config.mazeEnable) {
      return false;
    }
    this.every(1000 * 60 * 3, this.post, { immediate: true });

    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
  private async post() {
    if (nowHour() !== 22) return;
    const date = todayKey();
    const data = this.getData();
    if (data.lastPosted == date) return;
    data.lastPosted = date;
    this.setData(data);

    this.log('Time to maze');
    const file = await this.genMazeFile(date);

    this.log('Posting...');
    this.ai.post({
      text: serifs.maze.post,
      fileIds: [file.id],
    });
  }

  @bindThis
  private async genMazeFile(
    seed: string | number,
    size?: string | null
  ): Promise<DriveFile> {
    this.log('Maze generating...');
    const maze = genMaze(seed, size);

    this.log('Maze rendering...');
    const data = renderMaze(seed, maze);

    this.log('Image uploading...');
    const file = await this.ai.upload(data, {
      filename: 'maze.png',
      contentType: 'image/png',
    });

    return file;
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (msg.includes(['迷路'])) {
      let size: string | null = null;
      if (msg.includes(['接待'])) size = 'veryEasy';
      if (
        msg.includes([
          '簡単',
          'かんたん',
          '易しい',
          'やさしい',
          '小さい',
          'ちいさい',
        ])
      )
        size = 'easy';
      if (
        msg.includes(['難しい', 'むずかしい', '複雑な', '大きい', 'おおきい'])
      )
        size = 'hard';
      if (msg.includes(['死', '鬼', '地獄'])) size = 'veryHard';
      if (msg.includes(['藍']) && msg.includes(['本気'])) size = 'ai';
      this.log('Maze requested');
      setTimeout(async () => {
        const file = await this.genMazeFile(Date.now(), size);
        this.log('Replying...');
        msg.reply(serifs.maze.foryou, { file });
      }, 3000);
      return {
        reaction: 'like',
      };
    } else {
      return false;
    }
  }
}
