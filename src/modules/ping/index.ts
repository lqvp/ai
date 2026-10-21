import { HandlerResult } from '@/ai.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import { Note } from '@/misskey/note.js';
import Module from '@/module.js';

export default class extends Module {
  public readonly name = 'ping';

  @bindThis
  public install() {
    return { mentionHook: this.mentionHook };
  }

  @bindThis
  private async mentionHook(msg: Message): Promise<boolean | HandlerResult> {
    if (!msg.text?.includes('ping')) return false;

    const t0 = process.hrtime.bigint();

    // 1. 自分のノート作成 → Misskey 内部処理 + HTTPS RTT
    const posted = await msg.reply('🏓 PONG!', { immediate: true });

    const t1 = process.hrtime.bigint();
    const totalMs = Number(t1 - t0) / 1e6;

    // 2. 実際にノートが DB に書き込まれた時刻を取りに行く
    const noteDetail = (await this.ai.api('notes/show', {
      noteId: posted.id,
    })) as Note;
    const createdAt = new Date(noteDetail.createdAt).getTime();
    const serverDiff = createdAt - Date.now(); // サーバー時刻との差

    setTimeout(async () => {
      await msg.reply(
        `⏱️ **詳細レイテンシ**\n` +
          `総時間: ${totalMs.toFixed(2)} ms\n` +
          `サーバー時刻差: ${serverDiff.toFixed(0)} ms`
      );

      // 詳細レイテンシ情報にもリアクションを付ける
      await this.ai.reactions.react(msg.id, '⏱️', msg.friend);
    }, 200);

    // pingコマンド成功時のリアクション
    return {
      reaction: '🏓',
      immediate: true,
    };
  }
}
