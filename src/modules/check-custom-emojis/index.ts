import loki from 'lokijs';
import type { entities as MisskeyEntities } from 'misskey-js';
import config from '@/config/index.js';
import { bindThis } from '@/decorators.js';
import Message from '@/message.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { nowHour, todayKey } from '@/services/clock.js';

type EmojiDetailed = MisskeyEntities.EmojiDetailed;
const EMOJI_PAGE_SIZE = 100;
const DEFAULT_NOTE_TEXT_LIMIT = 3000;

function groupEmojiTexts(
  serverName: string,
  emojis: EmojiDetailed[],
  maxLength: number
): string[] {
  const { emojiOnce, postOnce } = serifs.checkCustomEmojis;
  const entries = emojis.map((emoji) => emojiOnce(emoji.name));
  const announcement = (text: string) =>
    postOnce(serverName, emojis.length, text);
  const fullText = announcement(entries.join(' '));
  if (fullText.length <= maxLength) return [fullText];

  const notes: string[] = [];
  let text = '';
  let format = (chunk: string) =>
    `${announcement(chunk)}\n続きは返信にあります。`;
  for (const entry of entries) {
    const nextText = text ? `${text} ${entry}` : entry;
    if (format(nextText).length <= maxLength) {
      text = nextText;
    } else {
      const note = format(text);
      if (note.length > maxLength || entry.length > maxLength) {
        throw new Error('Emoji announcement exceeds the note text limit');
      }
      notes.push(note);
      format = (chunk) => chunk;
      text = entry;
    }
  }
  notes.push(format(text));
  return notes;
}

export default class extends Module {
  public readonly name = 'checkCustomEmojis';

  private lastEmoji!: loki.Collection<{
    id: string;
    updatedAt: number;
  }>;
  private posting?: Promise<void>;

  @bindThis
  public install() {
    if (!config.checkEmojisEnabled) return false;
    this.lastEmoji = this.ai.getCollection('lastEmoji', {
      indices: ['id'],
    });

    this.every(1000 * 60 * 3, this.timeCheck, { immediate: true });

    return {
      mentionHook: this.mentionHook,
    };
  }

  @bindThis
  private timeCheck() {
    if (nowHour() !== 23) return;
    const date = todayKey();
    const data = this.getData();
    if (data.lastPosted == date) return;
    data.lastPosted = date;
    this.setData(data);

    this.log('Time to Check CustomEmojis!');
    return this.post();
  }

  @bindThis
  private post() {
    this.posting ??= this.postNewEmojis().finally(() => {
      this.posting = undefined;
    });
    return this.posting;
  }

  private async postNewEmojis() {
    this.log('Start to Check CustomEmojis.');
    const lastId = this.lastEmoji.findOne({})?.id ?? null;
    const emojisData = await this.fetchNewEmojis(lastId);
    if (emojisData.length == 0) {
      this.log('No CustomEmojis Added.');
      return;
    }

    const emojiSize = emojisData.length;

    const server_name = config.serverName ? config.serverName : 'このサーバー';
    this.log('Posting...');

    // 一気に投稿しないver
    if (!config.checkEmojisAtOnce) {
      // 概要について投稿
      this.log(serifs.checkCustomEmojis.post(server_name, emojiSize));
      await this.ai.post({
        text: serifs.checkCustomEmojis.post(server_name, emojiSize),
      });

      // 各絵文字について投稿
      for (const emoji of emojisData) {
        await this.ai.post({
          text: serifs.checkCustomEmojis.emojiPost(emoji.name),
        });
        this.saveCursor(emoji.id);
        this.log(serifs.checkCustomEmojis.emojiPost(emoji.name));
      }
    } else {
      const meta = await this.ai
        .api<{ maxNoteTextLength?: number }>('meta')
        .catch((error) => {
          this.logError('Could not fetch the note text limit', error);
          return { maxNoteTextLength: undefined };
        });
      const [text, ...replies] = groupEmojiTexts(
        server_name,
        emojisData,
        meta.maxNoteTextLength ?? DEFAULT_NOTE_TEXT_LIMIT
      );
      this.log(text);
      const announcement = await this.ai.post({ text });
      for (const reply of replies) {
        await this.ai.post({
          text: reply,
          replyId: announcement.id,
          visibility: announcement.visibility,
        });
      }
      this.saveCursor(emojisData[emojiSize - 1].id);
    }

    this.log('Check CustomEmojis finished!');
  }

  private saveCursor(id: string) {
    const cursor = this.lastEmoji.findOne({});
    const updatedAt = Date.now();
    if (cursor == null) {
      this.lastEmoji.insertOne({ id, updatedAt });
    } else {
      this.lastEmoji.update({ ...cursor, id, updatedAt });
    }
  }

  private async fetchNewEmojis(lastId: string | null) {
    this.log('CustomEmojis fetching...');
    if (lastId == null) {
      // 初回は既存の全絵文字を告知せず、最新の5件だけを対象にする。
      const newest = await this.ai.api<EmojiDetailed[]>('admin/emoji/list', {
        limit: 5,
      });
      return newest.reverse();
    }

    const emojis: EmojiDetailed[] = [];
    let sinceId = lastId;
    // sinceId を指定すると ID の昇順で返る。
    for (;;) {
      const page = await this.ai.api<EmojiDetailed[]>('admin/emoji/list', {
        sinceId,
        limit: EMOJI_PAGE_SIZE,
      });
      emojis.push(...page);
      if (page.length < EMOJI_PAGE_SIZE) return emojis;

      const nextId = page[page.length - 1].id;
      if (nextId === sinceId)
        throw new Error('Emoji pagination did not advance');
      sinceId = nextId;
    }
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (
      !msg.includes([
        'カスタム絵文字チェック',
        'カスタムえもじチェック',
        'カスタムえもじを調べて',
        'カスタムえもじを確認',
      ])
    ) {
      return false;
    } else {
      if (msg.user.username !== config.master || msg.user.host != null) {
        this.log('Check CustomEmojis requested but not master');
        return true;
      }
      this.log('Check CustomEmojis requested');
    }

    await this.post();

    return {
      reaction: 'like',
    };
  }
}
