import loki from 'lokijs';
import { describe, expect, it, vi } from 'vitest';
import type Ai from '../src/ai.js';
import type { PostParam } from '../src/api/APIClient.js';
import { initConfig, resolveConfig } from '../src/config/index.js';
import type Message from '../src/message.js';
import CheckCustomEmojis from '../src/modules/check-custom-emojis/index.js';
import { todayKey } from '../src/services/clock.js';

function makeEmojis(count: number) {
  return Array.from({ length: count }, (_, i) => {
    const id = String(i + 1).padStart(3, '0');
    return { id, name: `emoji_${id}` };
  });
}

function setup({
  emojis,
  lastId = '000',
  maxNoteTextLength = 3000,
  atOnce = true,
}: {
  emojis: ReturnType<typeof makeEmojis>;
  lastId?: string | null;
  maxNoteTextLength?: number;
  atOnce?: boolean;
}) {
  initConfig(
    resolveConfig({
      host: 'https://example.com',
      i: 'test-token',
      master: 'admin',
      checkEmojisEnabled: true,
      checkEmojisAtOnce: atOnce,
    })
  );

  const db = new loki('test-custom-emojis');
  const collection = db.addCollection<{ id: string; updatedAt: number }>(
    'lastEmoji'
  );
  if (lastId != null) collection.insertOne({ id: lastId, updatedAt: 0 });

  const api = vi.fn(
    async (endpoint: string, params?: { sinceId?: string; limit: number }) => {
      if (endpoint === 'meta') return { maxNoteTextLength };
      if (endpoint !== 'admin/emoji/list' || params == null) {
        throw new Error(`Unexpected API call: ${endpoint}`);
      }
      const { sinceId, limit } = params;
      return sinceId == null
        ? [...emojis].reverse().slice(0, limit)
        : emojis.filter((emoji) => emoji.id > sinceId).slice(0, limit);
    }
  );
  const post = vi.fn(async ({ text }: PostParam) => {
    if (text != null && text.length > maxNoteTextLength) {
      throw new Error('Note text exceeds server limit');
    }
    return { id: `note-${post.mock.calls.length}`, visibility: 'home' };
  });

  const module = new CheckCustomEmojis();
  module.init({
    api,
    post,
    getCollection: () => collection,
    log: vi.fn(),
    repos: {
      moduleData: { ensure: () => ({ data: { lastPosted: todayKey() } }) },
    },
  } as unknown as Ai);
  const { mentionHook } = module.getHooks();
  module.dispose();

  const check = () =>
    mentionHook?.({
      includes: () => true,
      user: { username: 'admin', host: null },
    } as unknown as Message);

  return {
    api,
    post,
    check,
    cursor: () => collection.find({}).map((e) => e.id),
  };
}

describe('custom emoji announcements', () => {
  it('announces more than one API page in a single note when it fits', async () => {
    const emojis = makeEmojis(105);
    const { api, post, check, cursor } = setup({ emojis });

    await check();

    expect(api.mock.calls).toEqual([
      ['admin/emoji/list', { sinceId: '000', limit: 100 }],
      ['admin/emoji/list', { sinceId: '100', limit: 100 }],
      ['meta'],
    ]);
    expect(post).toHaveBeenCalledExactlyOnceWith({
      text: `このサーバーに105件の絵文字が追加されました！\n${emojis
        .map(({ name }) => `:${name}:(\`${name}\`)`)
        .join(' ')} #AddCustomEmojis`,
    });
    expect(cursor()).toEqual(['105']);

    await check();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('puts only overflow in replies to the same announcement', async () => {
    const emojis = makeEmojis(12);
    const { post, check, cursor } = setup({ emojis, maxNoteTextLength: 120 });

    await check();

    const [root, ...replies] = post.mock.calls.map(([note]) => note);
    expect(root.replyId).toBeUndefined();
    expect(root.text).toContain('12件の絵文字');
    expect(root.text).toContain('続きは返信にあります。');
    expect(root.text).toContain(':emoji_001:');
    expect(replies.length).toBeGreaterThan(1);
    for (const reply of replies) {
      expect(reply).toMatchObject({ replyId: 'note-1', visibility: 'home' });
    }
    const combined = [root, ...replies].map(({ text }) => text).join('\n');
    const announced = [...combined.matchAll(/:(emoji_\d+):/g)].map(
      ([, name]) => name
    );
    expect(announced).toEqual(emojis.map(({ name }) => name));
    expect(cursor()).toEqual(['012']);
  });

  it('keeps the previous cursor when posting a reply fails', async () => {
    const { post, check, cursor } = setup({
      emojis: makeEmojis(12),
      maxNoteTextLength: 120,
    });
    post.mockResolvedValueOnce({ id: 'note-1', visibility: 'home' });
    post.mockRejectedValueOnce(new Error('Posting failed'));

    await expect(check()).rejects.toThrow('Posting failed');
    expect(cursor()).toEqual(['000']);
  });

  it('only fetches the newest five on the first check', async () => {
    const { api, post, check, cursor } = setup({
      emojis: makeEmojis(8),
      lastId: null,
    });

    await check();

    expect(api).toHaveBeenNthCalledWith(1, 'admin/emoji/list', { limit: 5 });
    expect(post.mock.calls[0][0].text).toContain('5件の絵文字');
    expect(post.mock.calls[0][0].text).not.toContain(':emoji_003:');
    expect(cursor()).toEqual(['008']);
  });

  it('keeps separate posts when checkEmojisAtOnce is off', async () => {
    const { post, check } = setup({ emojis: makeEmojis(2), atOnce: false });

    await check();

    expect(post).toHaveBeenCalledTimes(3);
    expect(post).toHaveBeenNthCalledWith(1, {
      text: 'このサーバーに2件の絵文字が追加されました！',
    });
  });
});
