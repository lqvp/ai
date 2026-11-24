import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  EmojiCatalog,
  type EmojiCatalogItem,
} from '../src/modules/aichat/emoji-catalog.js';

const dirs: string[] = [];

function createTempCachePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ai-aichat-emoji-'));
  dirs.push(dir);
  return join(dir, 'aichat-emojis-cache.json');
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const sampleEmojis: EmojiCatalogItem[] = [
  { name: 'arigato', aliases: ['thankyou'], category: '挨拶' },
  { name: 'neko_happy', aliases: ['cat'], category: '動物' },
  { name: 'iine', aliases: ['good'], category: 'リアクション' },
  {
    name: 'local_only_party',
    aliases: ['iwai'],
    category: 'お祝い',
    localOnly: true,
  },
  { name: 'nsfw_item', aliases: [], category: 'えち', isSensitive: false },
  { name: 'sensitive_flag', aliases: [], category: '一般', isSensitive: true },
  {
    name: 'role_locked',
    aliases: [],
    category: '管理',
    roleIdsThatCanBeUsedThisEmojiAsReaction: ['role-1'],
  },
];

describe('EmojiCatalog', () => {
  it('filters sensitive, NSFW categories and role-restricted emojis', async () => {
    const catalog = new EmojiCatalog({
      cacheFilePath: createTempCachePath(),
      fetchEmojis: async () => sampleEmojis,
    });

    const safe = await catalog.getSafeEmojis();
    const names = safe.map((e) => e.name);
    expect(names).toContain('arigato');
    expect(names).toContain('neko_happy');
    expect(names).not.toContain('nsfw_item');
    expect(names).not.toContain('sensitive_flag');
    expect(names).not.toContain('role_locked');
  });

  it('selects context-matching palette and excludes recentEmojis & localOnly for remote notes', async () => {
    const catalog = new EmojiCatalog({
      cacheFilePath: createTempCachePath(),
      fetchEmojis: async () => sampleEmojis,
    });

    const localPalette = await catalog.selectPalette('猫ちゃんありがとう！', {
      isRemoteNote: false,
      recentEmojis: [':iine:'],
      rng: () => 0.1,
    });
    expect(localPalette.some((p) => p.startsWith(':arigato:'))).toBe(true);
    expect(localPalette.some((p) => p.startsWith(':neko_happy:'))).toBe(true);
    expect(localPalette.some((p) => p.startsWith(':iine:'))).toBe(false);

    const remotePalette = await catalog.selectPalette('お祝い！', {
      isRemoteNote: true,
      rng: () => 0.1,
    });
    expect(remotePalette.some((p) => p.startsWith(':local_only_party:'))).toBe(
      false
    );
  });

  it('validates Unicode emojis, custom emojis, alias fallback and localOnly guards', async () => {
    const catalog = new EmojiCatalog({
      cacheFilePath: createTempCachePath(),
      fetchEmojis: async () => sampleEmojis,
    });

    expect(await catalog.validateReaction('🎉')).toBe('🎉');
    expect(await catalog.validateReaction(':arigato:')).toBe(':arigato:');
    // alias での救済
    expect(await catalog.validateReaction(':thankyou:')).toBe(':arigato:');
    // リモートノートに対する localOnly カスタム絵文字はフォールバック
    expect(
      await catalog.validateReaction(':local_only_party:', {
        isRemoteNote: true,
        fallback: '👍',
      })
    ).toBe('👍');
    // 存在しないカスタム絵文字
    expect(
      await catalog.validateReaction(':hallucinated_emoji:', {
        fallback: 'like',
      })
    ).toBe('like');
    expect(await catalog.validateReaction('none')).toBeNull();
    expect(await catalog.validateReaction(null)).toBeNull();
  });
});
