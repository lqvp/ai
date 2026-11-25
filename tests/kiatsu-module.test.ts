import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Ai from '../src/ai.js';
import type { PostParam } from '../src/api/APIClient.js';
import { initConfig, resolveConfig } from '../src/config/index.js';
import type Message from '../src/message.js';
import KiatsuModule from '../src/modules/kiatsu/index.js';
import type {
  HourlyForecast,
  HourlyPoint,
} from '../src/modules/kiatsu/open-meteo.js';
import * as openMeteo from '../src/modules/kiatsu/open-meteo.js';
import { formatLocalHourKey } from '../src/modules/kiatsu/pressure-trend.js';

const BASE_CONFIG = {
  host: 'https://example.com',
  i: 'test-token',
};

/** 指定時刻 `now` を基準に過去4時間〜未来12時間の予報系列を作る。 */
function buildForecastAt(
  now: Date,
  delta3h: number | null,
  options: { currentNull?: boolean; prev3hNull?: boolean } = {}
): HourlyForecast {
  const hours: HourlyPoint[] = [];
  const baseMs = now.getTime() - 4 * 60 * 60 * 1000;
  for (let i = 0; i < 17; i++) {
    const t = new Date(baseMs + i * 60 * 60 * 1000);
    let pressureMsl: number | null = 1015.0;
    if (i === 1 && options.prev3hNull) {
      pressureMsl = null;
    } else if (i === 4) {
      if (options.currentNull) {
        pressureMsl = null;
      } else if (delta3h !== null) {
        pressureMsl = Number((1015.0 + delta3h).toFixed(2));
      }
    }
    hours.push({
      timeLocal: formatLocalHourKey(t),
      pressureMsl,
      temperatureC: 14,
      weatherCode: 1,
    });
  }
  return {
    latitude: 36.3,
    longitude: 139.0,
    elevationM: 100,
    hours,
  };
}

function createHarness(
  kiatsuConfig: Record<string, unknown> = {},
  persistedData: Record<string, unknown> = {}
) {
  initConfig(
    resolveConfig({
      ...BASE_CONFIG,
      kiatsu: kiatsuConfig,
    } as Parameters<typeof resolveConfig>[0])
  );

  const doc = { module: 'kiatsu', data: { ...persistedData } };
  const posts: string[] = [];
  const logs: string[] = [];

  const post = vi.fn(async (param: PostParam) => {
    if (param.text) posts.push(param.text);
    return { id: `note-${posts.length}` };
  });
  const upload = vi.fn(async () => ({ id: 'file-1', name: 'kiatsu.png' }));
  const log = vi.fn((msg: string) => {
    logs.push(msg);
  });
  const save = vi.fn();

  const mod = new KiatsuModule();
  mod.init({
    post,
    upload,
    log,
    repos: {
      moduleData: {
        ensure: () => doc,
        save,
      },
    },
  } as unknown as Ai);

  return { mod, doc, posts, logs, post, upload, save };
}

function makeMentionMessage(text = '気圧教えて') {
  const reply = vi.fn(
    async (_text: string, _opts?: { immediate?: boolean; file?: unknown }) => ({
      id: 'reply-1',
    })
  );
  const message = {
    includes: (words: string[]) => words.some((w) => text.includes(w)),
    reply,
  } as unknown as Message;
  return { message, reply };
}

describe('KiatsuModule (index.ts)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-25T11:00:00Z')); // 20:00 JST
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('enabled: false のときはフックを一切登録せず API も呼ばない', () => {
    const fetchSpy = vi.spyOn(openMeteo, 'fetchForecast');
    const { mod } = createHarness({ enabled: false });

    const hooks = mod.getHooks();
    expect(hooks).toEqual({});
    expect(fetchSpy).not.toHaveBeenCalled();
    mod.dispose();
  });

  it('旧設定キーが残っていれば起動時に1回だけ警告ログを出す', async () => {
    vi.spyOn(openMeteo, 'fetchForecast').mockResolvedValue(
      buildForecastAt(new Date(), 0)
    );
    const { mod, logs } = createHarness({
      locationCode: '13102',
      postIntervalMs: 43200000,
    });

    mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);

    const warnings = logs.filter((l) => l.includes('廃止された設定キー'));
    expect(warnings).toHaveLength(1);
    mod.dispose();
  });

  it('カスタム座標かつ locationName 未設定時、公開投稿や返信に座標を漏洩しない', async () => {
    vi.spyOn(openMeteo, 'fetchForecast').mockResolvedValue(
      buildForecastAt(new Date(), -2.4)
    );
    const { mod, posts } = createHarness({
      latitude: 36.3219,
      longitude: 139.0033,
    });

    const hooks = mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);

    expect(posts).toHaveLength(1);
    expect(posts[0]).not.toContain('36.32');
    expect(posts[0]).not.toContain('139.00');
    expect(posts[0]).toContain('直近3時間で -2.4 hPa');

    const { message, reply } = makeMentionMessage();
    await hooks.mentionHook!(message);
    const replyText = reply.mock.calls[0]?.[0] as string;
    expect(replyText).not.toContain('36.32');
    expect(replyText).not.toContain('139.00');

    mod.dispose();
  });

  it('解除境界 0（threshold -2.0 + hysteresis 2.0）で投稿成功後、横ばい 0.0 hPa で解除され再警報できる', async () => {
    const fetchSpy = vi.spyOn(openMeteo, 'fetchForecast');
    fetchSpy.mockResolvedValueOnce(buildForecastAt(new Date(), -2.5));

    const { mod, posts } = createHarness({
      alertThresholdHpa: -2.0,
      hysteresisHpa: 2.0,
      maxPostsPerDay: 5,
      updateIntervalMs: 600_000,
    });

    mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);

    // 10分後: 0.0 hPa（横ばい）で解除されること
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date(Date.now() + 600_000), 0)
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(posts).toHaveLength(1);

    // さらに10分後: -3.0 hPa で再び警報が発火すること
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date(Date.now() + 600_000), -3.0)
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain('-3.0 hPa');

    mod.dispose();
  });

  it('日次上限で見送った警報が翌日ヒステリシス帯（-1.5 hPa）に浅くなっていたら誤投稿せず翌日の枠を守る', async () => {
    // Day 1 23:40 JST (14:40Z)
    vi.setSystemTime(new Date('2026-11-25T14:40:00Z'));
    const fetchSpy = vi.spyOn(openMeteo, 'fetchForecast');

    // 23:40 JST: 1回目の急降下 (-3.0 hPa) → 投稿成功（Day 1 の上限 1/1 消費）
    fetchSpy.mockResolvedValueOnce(buildForecastAt(new Date(), -3.0));
    const { mod, posts } = createHarness({
      alertThresholdHpa: -2.0,
      hysteresisHpa: 0.5,
      maxPostsPerDay: 1,
      updateIntervalMs: 600_000,
    });
    mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(1);

    // 23:50 JST: 一旦回復 (0.0 hPa) → 解除
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date('2026-11-25T14:50:00Z'), 0)
    );
    await vi.advanceTimersByTimeAsync(600_000);

    // Day 2 00:00 の直前 23:55 に合わせて評価させる代わりに 23:50→00:00→00:10 をテスト:
    // 再設定して Day 1 内に上限見送りを作る
    mod.dispose();

    vi.setSystemTime(new Date('2026-11-25T14:50:00Z')); // 23:50 JST
    fetchSpy.mockResolvedValueOnce(buildForecastAt(new Date(), -2.2));
    const h2 = createHarness(
      {
        alertThresholdHpa: -2.0,
        hysteresisHpa: 0.5,
        maxPostsPerDay: 1,
        updateIntervalMs: 600_000,
      },
      {
        spot: '35.6702,139.774',
        thresholdHpa: -2.0,
        savedAtMs: Date.now(),
        alerting: false,
        pending: false,
        postsToday: 1,
        postsTodayKey: '2026-11-25',
      }
    );
    h2.mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    // Day 1 上限済みのため投稿されないが pendingAlert は立つ
    expect(h2.posts).toHaveLength(0);

    // Day 2 00:00 JST (15:00Z): -1.5 hPa（ヒステリシス帯、閾値 -2.0 未達）→ 誤投稿しないこと！
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date('2026-11-25T15:00:00Z'), -1.5)
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h2.posts).toHaveLength(0);

    // Day 2 00:10 JST: 一旦 0.0 hPa で解除 → 00:20 JST に本物の -3.5 hPa が来たら投稿できること！
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date('2026-11-25T15:10:00Z'), 0)
    );
    await vi.advanceTimersByTimeAsync(600_000);

    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date('2026-11-25T15:20:00Z'), -3.5)
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h2.posts).toHaveLength(1);
    expect(h2.posts[0]).toContain('-3.5 hPa');

    h2.mod.dispose();
  });

  it('瞬断中に連続メンションが来ても監視停止せず、通信全断でも UnhandledRejection を出さない', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);

    try {
      const fetchSpy = vi
        .spyOn(openMeteo, 'fetchForecast')
        .mockRejectedValue(new Error('network down'));

      const { mod, post, posts } = createHarness({
        maxErrorRetries: 2,
        updateIntervalMs: 600_000,
      });
      post.mockRejectedValue(new Error('misskey down'));

      const hooks = mod.getHooks();
      await vi.advanceTimersByTimeAsync(0); // 定期失敗 1回目

      // メンションが6連続で来ても countErrors: false なので停止しない
      for (let i = 0; i < 6; i++) {
        const { message, reply } = makeMentionMessage();
        reply.mockRejectedValueOnce(new Error('reply failed'));
        await hooks.mentionHook!(message);
      }
      expect(posts).toHaveLength(0);

      // 定期失敗 2回目・3回目（maxErrorRetries=2 超過で停止遷移、post が reject しても安全）
      await vi.advanceTimersByTimeAsync(600_000);
      await vi.advanceTimersByTimeAsync(600_000);

      expect(unhandled).toHaveLength(0);
      expect(fetchSpy).toHaveBeenCalled();
      mod.dispose();
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('鮮度切れ（2時間超）では古い画像を添付せず、3時間前欠測時は画像と CC-BY 出典 URL を両方付ける', async () => {
    const fetchSpy = vi.spyOn(openMeteo, 'fetchForecast');
    // 初回取得成功
    fetchSpy.mockResolvedValueOnce(buildForecastAt(new Date(), -1.2));

    const { mod } = createHarness({
      locationName: '高崎市',
      updateIntervalMs: 3_600_000,
    });
    const hooks = mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);

    // 以降ずっと取得失敗にしたまま 3時間経過させる（鮮度切れ）
    fetchSpy.mockRejectedValue(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);

    const staleMention = makeMentionMessage();
    await hooks.mentionHook!(staleMention.message);
    expect(staleMention.reply).toHaveBeenCalledWith(
      expect.stringContaining('取得できませんでした'),
      expect.objectContaining({ file: undefined })
    );

    // 次に最新予報は取れたが 3時間前の点だけ null のケース
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date(), null, { prev3hNull: true })
    );
    const partialMention = makeMentionMessage();
    await hooks.mentionHook!(partialMention.message);
    const [partialText, partialOpts] = partialMention.reply.mock.calls[0] as [
      string,
      { file?: unknown },
    ];
    expect(partialOpts.file).toBeDefined();
    expect(partialText).toContain('欠測');
    expect(partialText).toContain('https://open-meteo.com/');
    expect(partialText).toContain(
      'https://creativecommons.org/licenses/by/4.0/'
    );

    mod.dispose();
  });

  it('地点変更での再起動は警報状態を捨てて日次枠を残し、長時間停止後の再起動も古い警報を捨てる', async () => {
    const fetchSpy = vi.spyOn(openMeteo, 'fetchForecast');
    fetchSpy.mockResolvedValue(buildForecastAt(new Date(), -2.6));

    // 1. 地点変更あり・当日投稿済み 1/1 → 警報状態はリセットされるが日次枠 1/1 は維持される
    const spotChanged = createHarness(
      { latitude: 36.32, longitude: 139.0, maxPostsPerDay: 1 },
      {
        spot: '35.6702,139.774',
        thresholdHpa: -2.0,
        savedAtMs: Date.now() - 60_000,
        alerting: true,
        pending: false,
        postsToday: 1,
        postsTodayKey: '2026-11-25',
      }
    );
    spotChanged.mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    expect(spotChanged.posts).toHaveLength(0); // 当日枠 1/1 が維持されているため見送り
    expect(spotChanged.doc.data.alerting).toBe(true); // ただし新地点で新しく trigger して alerting になった
    spotChanged.mod.dispose();

    // 2. 同一地点だが 5時間停止後の再起動（枠は未消費）→ 古い alerting: true に邪魔されず新規発火する
    const expired = createHarness(
      { latitude: 36.32, longitude: 139.0, maxPostsPerDay: 1 },
      {
        spot: '36.32,139',
        thresholdHpa: -2.0,
        savedAtMs: Date.now() - 5 * 3_600_000,
        alerting: true,
        pending: false,
        postsToday: 0,
        postsTodayKey: '2026-11-25',
      }
    );
    expired.mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    expect(expired.posts).toHaveLength(1);
    expired.mod.dispose();
  });
});
