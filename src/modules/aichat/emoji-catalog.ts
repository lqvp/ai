import { parse as parseTwemoji } from 'twemoji-parser';
import { JsonFileStore } from './json-file-store.js';

export type EmojiCatalogItem = {
  name: string;
  aliases: string[];
  category: string | null;
  localOnly?: boolean;
  isSensitive?: boolean;
  roleIdsThatCanBeUsedThisEmojiAsReaction?: string[];
};

type EmojiCacheFile = {
  fetchedAt: number;
  emojis: EmojiCatalogItem[];
};

export type EmojiCatalogOptions = {
  cacheFilePath: string;
  fetchEmojis: () => Promise<EmojiCatalogItem[]>;
  cacheTtlHours?: number;
  nsfwCategories?: string[];
  log?: (message: string) => void;
  now?: () => number;
};

export type SelectPaletteOptions = {
  isRemoteNote?: boolean;
  recentEmojis?: readonly string[];
  maxCount?: number;
  rng?: () => number;
};

export type ValidateReactionOptions = {
  isRemoteNote?: boolean;
  fallback?: string | null;
};

const DEFAULT_NSFW_RE = /えち|nsfw|r-?18|エロ|性的|porn|hentai/i;
const CUSTOM_EMOJI_NAME_RE = /^[a-zA-Z0-9_+-]+$/;

/** 日本語の気分・話題キーワードからカスタム絵文字検索語への軽量マッピング */
const CONTEXT_STEMS: readonly [RegExp, readonly string[]][] = [
  [/ありがと|感謝|助か|たすか|礼/i, ['arigato', 'thank', 'kansha', 'heart']],
  [/おはよ|朝/i, ['ohayo', 'morning', 'sun']],
  [/おやすみ|寝|眠|ねむ/i, ['oyasumi', 'sleep', 'nemui', 'zzz', 'futon']],
  [/草|笑|わろ|ｗ|w{2,}/i, ['kusa', 'wara', 'lol', 'smile', 'niyari']],
  [
    /飯|ご飯|ごはん|食べ|美味|うま|ランチ|夕飯|朝飯/i,
    ['meshi', 'food', 'oishii', 'gohan', 'yummy', 'ramen', 'curry'],
  ],
  [
    /おめでと|祝|誕生日|合格|記念/i,
    ['omedeto', 'congrats', 'iwai', 'party', 'クラッカー'],
  ],
  [
    /疲|つかれ|しんど|仕事|残業|無理/i,
    ['otsukare', 'pien', 'iyashi', 'coffee', 'care'],
  ],
  [/猫|ねこ|にゃ|ぬこ/i, ['neko', 'cat', 'nyan', 'nya']],
  [/犬|いぬ|わん/i, ['inu', 'dog', 'wan']],
  [
    /可愛|かわい|尊|すき|好き|推/i,
    ['kawaii', 'cute', 'love', 'suki', 'heart', 'toutoi'],
  ],
  [
    /すご|凄|神|えら|偉|天才|最高/i,
    ['sugoi', 'kami', 'erai', 'star', 'sparkle', 'saikou'],
  ],
  [/応援|頑張|がんば|ファイト/i, ['ouen', 'ganba', 'fight', 'yoshi']],
  [/驚|えっ|まじ|マジ|びっくり/i, ['ee', 'bikkuri', 'surprise', 'shock']],
  [/悲|泣|つら|ぴえん/i, ['cry', 'sad', 'pien', 'yoshiyoshi']],
  [/お茶|コーヒー|紅茶|酒|飲/i, ['tea', 'coffee', 'drink', 'kanpai']],
  [/おつかれ|お疲れ/i, ['otsukare', 'otsu']],
  [/わか|理解|なるほど/i, ['wakaru', 'naruhodo', 'sorena', 'nod']],
  [/よし|やるぞ/i, ['yoshi', 'ok', 'good']],
];

const STAPLE_HINTS = [
  'like',
  'love',
  'heart',
  'good',
  'nice',
  'smile',
  'happy',
  'laugh',
  'nod',
  'wai',
  'yoshi',
  'naruhodo',
  'wakaru',
  'otsukare',
  'kawaii',
  'sugoi',
  'arigato',
  'kusa',
  'ok',
  'clap',
  'star',
  'sparkle',
  'iine',
];

function normalizeCacheFile(raw: unknown): EmojiCacheFile {
  const obj =
    raw != null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
  const fetchedAt =
    typeof obj.fetchedAt === 'number' && Number.isFinite(obj.fetchedAt)
      ? obj.fetchedAt
      : 0;
  const emojis = Array.isArray(obj.emojis)
    ? obj.emojis
        .filter(
          (e): e is EmojiCatalogItem => e != null && typeof e === 'object'
        )
        .filter(
          (e) =>
            typeof e.name === 'string' &&
            e.name.trim() !== '' &&
            CUSTOM_EMOJI_NAME_RE.test(e.name)
        )
        .map((e) => ({
          name: e.name,
          aliases: Array.isArray(e.aliases)
            ? e.aliases.filter((a): a is string => typeof a === 'string')
            : [],
          category: typeof e.category === 'string' ? e.category : null,
          localOnly: Boolean(e.localOnly),
          isSensitive: Boolean(e.isSensitive),
          roleIdsThatCanBeUsedThisEmojiAsReaction: Array.isArray(
            e.roleIdsThatCanBeUsedThisEmojiAsReaction
          )
            ? e.roleIdsThatCanBeUsedThisEmojiAsReaction.filter(
                (r): r is string => typeof r === 'string'
              )
            : [],
        }))
    : [];

  return { fetchedAt, emojis };
}

function sampleShuffled<T>(
  items: readonly T[],
  limit: number,
  rng: () => number
): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, limit);
}

/**
 * インスタンスのカスタム絵文字一覧を 6 時間キャッシュし、
 * NSFW・ロール制限を除外した動的ショートリスト生成と送信前バリデーションを提供する。
 */
export class EmojiCatalog {
  private readonly store: JsonFileStore<EmojiCacheFile>;
  private readonly fetchEmojis: () => Promise<EmojiCatalogItem[]>;
  private readonly cacheTtlMs: number;
  private readonly nsfwCategoriesLower: string[];
  private readonly log: (message: string) => void;
  private readonly now: () => number;

  private memoryCache: { fetchedAt: number; safe: EmojiCatalogItem[] } | null =
    null;

  constructor(options: EmojiCatalogOptions) {
    this.fetchEmojis = options.fetchEmojis;
    this.cacheTtlMs = (options.cacheTtlHours ?? 6) * 3_600_000;
    this.nsfwCategoriesLower = (options.nsfwCategories ?? []).map((c) =>
      c.toLowerCase()
    );
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.store = new JsonFileStore<EmojiCacheFile>({
      filePath: options.cacheFilePath,
      createDefault: () => ({ fetchedAt: 0, emojis: [] }),
      normalize: normalizeCacheFile,
      resetOnCorrupt: true,
      log: options.log,
      now: this.now,
    });
  }

  public isSafeEmoji(item: EmojiCatalogItem): boolean {
    if (!item.name || !CUSTOM_EMOJI_NAME_RE.test(item.name)) return false;
    if (item.isSensitive) return false;
    if (
      item.roleIdsThatCanBeUsedThisEmojiAsReaction &&
      item.roleIdsThatCanBeUsedThisEmojiAsReaction.length > 0
    ) {
      return false;
    }

    const category = item.category ?? '';
    const hay = [item.name, category, ...item.aliases].join(' ');
    if (DEFAULT_NSFW_RE.test(hay)) return false;

    const categoryLower = category.toLowerCase();
    if (
      categoryLower &&
      this.nsfwCategoriesLower.some((ng) => categoryLower.includes(ng))
    ) {
      return false;
    }

    return true;
  }

  public async getSafeEmojis(): Promise<EmojiCatalogItem[]> {
    const nowMs = this.now();
    if (
      this.memoryCache &&
      this.memoryCache.safe.length > 0 &&
      nowMs - this.memoryCache.fetchedAt < this.cacheTtlMs
    ) {
      return this.memoryCache.safe;
    }

    const disk = await this.store.load();
    if (disk.emojis.length > 0 && nowMs - disk.fetchedAt < this.cacheTtlMs) {
      const safe = disk.emojis.filter((e) => this.isSafeEmoji(e));
      this.memoryCache = { fetchedAt: disk.fetchedAt, safe };
      return safe;
    }

    try {
      const raw = await this.fetchEmojis();
      const safe = raw.filter((e) => this.isSafeEmoji(e));
      await this.store.update(() => ({
        next: { fetchedAt: nowMs, emojis: safe },
        result: undefined,
      }));
      this.memoryCache = { fetchedAt: nowMs, safe };
      return safe;
    } catch (err: unknown) {
      this.log(
        `カスタム絵文字一覧の取得に失敗しました: ${err instanceof Error ? err.message : String(err)}`
      );
      if (disk.emojis.length > 0) {
        const safe = disk.emojis.filter((e) => this.isSafeEmoji(e));
        this.memoryCache = { fetchedAt: disk.fetchedAt, safe };
        return safe;
      }
      return this.memoryCache?.safe ?? [];
    }
  }

  /**
   * 文脈に応じた3層ショートリスト（最大約28件）をプロンプト用文字列の配列で返す。
   */
  public async selectPalette(
    contextText: string,
    options: SelectPaletteOptions = {}
  ): Promise<string[]> {
    const {
      isRemoteNote = false,
      recentEmojis = [],
      maxCount = 28,
      rng = Math.random,
    } = options;

    const allSafe = await this.getSafeEmojis();
    const pool = isRemoteNote ? allSafe.filter((e) => !e.localOnly) : allSafe;
    if (pool.length === 0) return [];

    const recentSet = new Set(recentEmojis.map((e) => e.toLowerCase()));
    const chosen: EmojiCatalogItem[] = [];
    const chosenNames = new Set<string>();

    const addItem = (item: EmojiCatalogItem): boolean => {
      if (chosen.length >= maxCount) return false;
      const lower = item.name.toLowerCase();
      if (chosenNames.has(lower)) return false;
      chosenNames.add(lower);
      chosen.push(item);
      return true;
    };

    // Layer 1a: 会話文中に既出の安全な :emoji:
    for (const match of contextText.matchAll(/:([a-zA-Z0-9_+-]+):/g)) {
      const name = match[1].toLowerCase();
      const found = pool.find((e) => e.name.toLowerCase() === name);
      if (found) addItem(found);
    }

    // Layer 1b: 日本語ステミングに基づく文脈マッチ（最大12件）
    const hints = new Set<string>();
    for (const [pattern, stems] of CONTEXT_STEMS) {
      if (pattern.test(contextText)) {
        for (const s of stems) hints.add(s.toLowerCase());
      }
    }
    if (hints.size > 0) {
      const matched = pool.filter((e) => {
        const hay = [e.name, e.category ?? '', ...e.aliases]
          .join(' ')
          .toLowerCase();
        for (const hint of hints) {
          if (hay.includes(hint)) return true;
        }
        return false;
      });
      for (const item of sampleShuffled(matched, 12, rng)) {
        addItem(item);
      }
    }

    // Layer 2: 汎用定番（直近5件の重複を除外、最大10件）
    const nonRecentPool = pool.filter(
      (e) => !recentSet.has(`:${e.name.toLowerCase()}:`)
    );
    const staples = nonRecentPool.filter((e) => {
      const hay = [e.name, ...e.aliases].join(' ').toLowerCase();
      return STAPLE_HINTS.some((hint) => hay.includes(hint));
    });
    for (const item of sampleShuffled(staples, 10, rng)) {
      addItem(item);
    }

    // Layer 3: ローカル絵文字からのランダム枠（最大8件、残枠まで）
    const remaining = (nonRecentPool.length > 0 ? nonRecentPool : pool).filter(
      (e) => !chosenNames.has(e.name.toLowerCase())
    );
    const localLimit = Math.min(8, Math.max(0, maxCount - chosen.length));
    for (const item of sampleShuffled(remaining, localLimit, rng)) {
      addItem(item);
    }

    return chosen.map((e) => {
      const aliases = e.aliases.slice(0, 2);
      return aliases.length > 0
        ? `:${e.name}:(${aliases.join(',')})`
        : `:${e.name}:`;
    });
  }

  /**
   * LLM が出力したリアクション文字列を検証・正規化する。
   * null / 'none' / 空文字はリアクションなし(null)、不正絵文字は fallback へ落とす。
   */
  public async validateReaction(
    raw: unknown,
    options: ValidateReactionOptions = {}
  ): Promise<string | null> {
    const { isRemoteNote = false, fallback = 'like' } = options;
    if (raw == null) return null;
    if (typeof raw !== 'string') return fallback;

    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.toLowerCase() === 'none') {
      return null;
    }

    // カスタム絵文字 :name:
    if (
      trimmed.startsWith(':') &&
      trimmed.endsWith(':') &&
      trimmed.length >= 3
    ) {
      const name = trimmed.slice(1, -1).trim();
      if (!CUSTOM_EMOJI_NAME_RE.test(name)) return fallback;

      const safe = await this.getSafeEmojis();
      const lower = name.toLowerCase();
      const exact = safe.find((e) => e.name.toLowerCase() === lower);
      if (exact) {
        if (isRemoteNote && exact.localOnly) return fallback;
        return `:${exact.name}:`;
      }

      // ハルシネーション時は aliases の完全一致を1回だけ救済
      const byAlias = safe.find((e) =>
        e.aliases.some((a) => a.toLowerCase() === lower)
      );
      if (byAlias && (!isRemoteNote || !byAlias.localOnly)) {
        return `:${byAlias.name}:`;
      }

      return fallback;
    }

    // Unicode 絵文字（単一絵文字のみ許可）
    const parsed = parseTwemoji(trimmed);
    if (parsed.length === 1 && parsed[0].text === trimmed) {
      return trimmed;
    }

    return fallback;
  }
}
