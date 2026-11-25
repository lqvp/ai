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
  const api = vi.fn(async () => ({}));
  const upload = vi.fn(async () => ({ id: 'file-1', name: 'kiatsu.png' }));
  const log = vi.fn((msg: string) => {
    logs.push(msg);
  });
  const save = vi.fn();

  const mod = new KiatsuModule();
  mod.init({
    api,
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

  return { mod, doc, posts, logs, api, post, upload, save };
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
    expect(h2.doc.data.pending).toBe(true);

    // Day 2 00:00 JST (15:00Z): -1.5 hPa（ヒステリシス帯、閾値 -2.0 未達）→ 保留のまま誤投稿しないこと！
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date('2026-11-25T15:00:00Z'), -1.5)
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h2.posts).toHaveLength(0);
    expect(h2.doc.data.pending).toBe(true);

    // Day 2 00:10 JST: 一旦 0.0 hPa で解除 → 00:20 JST に本物の -3.5 hPa が来たら投稿できること！
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date('2026-11-25T15:10:00Z'), 0)
    );
    await vi.advanceTimersByTimeAsync(600_000);
    expect(h2.doc.data.pending).toBe(false);

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

      const { mod, post } = createHarness({
        maxErrorRetries: 2,
        updateIntervalMs: 600_000,
      });
      post.mockRejectedValue(new Error('misskey down'));

      const hooks = mod.getHooks();
      await vi.advanceTimersByTimeAsync(0); // 定期失敗 1回目

      // メンションが6連続で来ても countErrors: false なので停止通知すら試行されない
      for (let i = 0; i < 6; i++) {
        const { message, reply } = makeMentionMessage();
        reply.mockRejectedValueOnce(new Error('reply failed'));
        await hooks.mentionHook!(message);
      }
      expect(post).not.toHaveBeenCalled();

      // 定期失敗 2回目（まだ閾値 2 以内）
      await vi.advanceTimersByTimeAsync(600_000);
      expect(post).not.toHaveBeenCalled();

      // 定期失敗 3回目（maxErrorRetries=2 超過で初めて停止通知が1回試行され、post が reject しても安全）
      await vi.advanceTimersByTimeAsync(600_000);
      expect(post).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith(
        expect.objectContaining({
          text: expect.stringContaining('一時停止しました'),
        })
      );

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

    // 以降ずっと取得失敗にしたまま 3時間経過させる（鮮度切れ、計 4 回の定期試行）
    fetchSpy.mockRejectedValue(new Error('timeout'));
    await vi.advanceTimersByTimeAsync(3 * 3_600_000);
    expect(fetchSpy).toHaveBeenCalledTimes(4);

    // 直近の試行から updateIntervalMs 未満の連続メンションは外部 API を再試行せず失敗返信を返す
    vi.setSystemTime(new Date(Date.now() + 10_000));
    const staleMention = makeMentionMessage();
    await hooks.mentionHook!(staleMention.message);
    const staleMention2 = makeMentionMessage();
    await hooks.mentionHook!(staleMention2.message);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(staleMention.reply).toHaveBeenCalledWith(
      expect.stringContaining('取得できませんでした'),
      expect.objectContaining({ file: undefined })
    );

    // updateIntervalMs 以上経過した後のメンションでは再取得でき、3時間前の点だけ null のケースを処理する
    vi.setSystemTime(new Date(Date.now() + 3_600_000));
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date(), null, { prev3hNull: true })
    );
    const partialMention = makeMentionMessage();
    await hooks.mentionHook!(partialMention.message);
    expect(fetchSpy).toHaveBeenCalledTimes(5);
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
    expect(spotChanged.doc.data.alerting).toBe(true);
    expect(spotChanged.doc.data.pending).toBe(true); // 既存状態を捨てて新地点で新規発火・保留された証拠
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

  it('取得失敗中に日付変更（syncPostDay）を挟んでも古い警報状態の鮮度時刻を更新しない', async () => {
    // Day 1 20:00 JST (11:00Z) に警報投稿成功
    const fetchSpy = vi.spyOn(openMeteo, 'fetchForecast');
    fetchSpy.mockResolvedValueOnce(buildForecastAt(new Date(), -2.5));

    const run1 = createHarness({
      latitude: 36.32,
      longitude: 139.0,
      updateIntervalMs: 3_600_000,
      maxErrorRetries: 10,
    });
    run1.mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    expect(run1.posts).toHaveLength(1);
    const savedAt20 = run1.doc.data.savedAtMs;
    expect(typeof savedAt20).toBe('number');

    // 以降ずっと取得失敗にしたまま 4時間経過 → Day 2 00:00 JST (15:00Z) で syncPostDay が走る
    fetchSpy.mockRejectedValue(new Error('open-meteo down'));
    await vi.advanceTimersByTimeAsync(4 * 3_600_000);
    // 日次枠はリセットされても savedAtMs は 20:00 のまま維持されていること
    expect(run1.doc.data.postsToday).toBe(0);
    expect(run1.doc.data.savedAtMs).toBe(savedAt20);
    const persistedSnapshot = { ...run1.doc.data };
    run1.mod.dispose();

    // 直後の 00:05 JST にプロセス再起動し、取得が復旧（-2.8 hPa）したら古い alerting は期限切れで新規警報が出ること
    vi.setSystemTime(new Date('2026-11-25T15:05:00Z'));
    fetchSpy.mockReset();
    fetchSpy.mockResolvedValueOnce(buildForecastAt(new Date(), -2.8));
    const run2 = createHarness(
      { latitude: 36.32, longitude: 139.0 },
      persistedSnapshot
    );
    run2.mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    expect(run2.posts).toHaveLength(1);
    expect(run2.posts[0]).toContain('-2.8 hPa');
    run2.mod.dispose();
  });

  it('画像アップロード中に鮮度上限を超えた場合は返信直前の再判定で画像添付と数値を抑止しドライブからも消す', async () => {
    const fetchSpy = vi.spyOn(openMeteo, 'fetchForecast');
    fetchSpy.mockResolvedValueOnce(buildForecastAt(new Date(), -1.4));

    const { mod, api, upload, logs } = createHarness({
      locationName: '高崎市',
      updateIntervalMs: 10_800_000, // 3時間（キャッシュ有効だが鮮度境界手前を作る）
    });
    const hooks = mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);

    // 観測時刻（20:00 JST）から 1時間59分59秒後（まだギリギリ STALE_MS=2h 以内）に進める
    vi.setSystemTime(new Date('2026-11-25T12:59:59Z'));
    let rejectDelete!: (reason?: unknown) => void;
    api.mockImplementationOnce(
      () =>
        new Promise((_resolve, reject) => {
          rejectDelete = reject;
        })
    );
    upload.mockImplementationOnce(async () => {
      // アップロードに 5 秒かかり、完了時点で 2時間0分4秒（鮮度切れ）になる状況を模擬
      vi.setSystemTime(new Date('2026-11-25T13:00:04Z'));
      return { id: 'file-late', name: 'kiatsu.png' };
    });

    // drive/files/delete が未完了でも message.reply がブロックされず即座に完了すること
    const { message, reply } = makeMentionMessage();
    await hooks.mentionHook!(message);

    expect(reply).toHaveBeenCalledWith(
      expect.stringContaining('取得できませんでした'),
      expect.objectContaining({ file: undefined })
    );
    expect(api).toHaveBeenCalledWith('drive/files/delete', {
      fileId: 'file-late',
    });

    // 遅延して削除が失敗しても UnhandledRejection にならずログに記録されること
    rejectDelete(new Error('delete timeout'));
    await Promise.resolve();
    expect(
      logs.some((l) =>
        l.includes('不要になった予報画像の削除に失敗しました: file-late')
      )
    ).toBe(true);
    mod.dispose();
  });

  it('20:58 取得直後に正時をまたいで 21:03 にメンションされた場合、再取得せず 21:00 の予報点を返す', async () => {
    vi.setSystemTime(new Date('2026-11-25T11:58:00Z')); // 20:58 JST
    const forecast: HourlyForecast = {
      latitude: 36.32,
      longitude: 139.0,
      elevationM: 100,
      hours: [
        {
          timeLocal: '2026-11-25T17:00',
          pressureMsl: 1015.0,
          temperatureC: 12,
          weatherCode: 0,
        },
        {
          timeLocal: '2026-11-25T18:00',
          pressureMsl: 1015.0,
          temperatureC: 12,
          weatherCode: 0,
        },
        {
          timeLocal: '2026-11-25T19:00',
          pressureMsl: 1015.0,
          temperatureC: 12,
          weatherCode: 0,
        },
        {
          timeLocal: '2026-11-25T20:00',
          pressureMsl: 1014.4,
          temperatureC: 11,
          weatherCode: 1,
        }, // 20:00 Δ3h = -0.6
        {
          timeLocal: '2026-11-25T21:00',
          pressureMsl: 1013.3,
          temperatureC: 10,
          weatherCode: 2,
        }, // 21:00 Δ3h = -1.7
        {
          timeLocal: '2026-11-25T22:00',
          pressureMsl: 1012.9,
          temperatureC: 10,
          weatherCode: 2,
        }, // 22:00 Δ3h = -2.1
      ],
    };
    const fetchSpy = vi
      .spyOn(openMeteo, 'fetchForecast')
      .mockResolvedValue(forecast);

    const { mod } = createHarness({
      locationName: '高崎市',
      updateIntervalMs: 10_800_000, // 3時間間隔（22:01 時点でも取得から 1h03m でキャッシュ有効）
    });
    const hooks = mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 20:59 JST のメンション → 20:00 時点 (-0.6 hPa)
    vi.setSystemTime(new Date('2026-11-25T11:59:00Z'));
    const m1 = makeMentionMessage();
    await hooks.mentionHook!(m1.message);
    expect(m1.reply.mock.calls[0]?.[0]).toContain('-0.6 hPa');
    expect(m1.reply.mock.calls[0]?.[0]).toContain('20:00時点');

    // 22:01 JST のメンション（取得 20:58 から 1h03m 経過、当時の 20:00 点からは 2h01m 超だが 22:00 点は新鮮）
    // → API 再取得なしで 22:00 時点 (-2.1 hPa) を返す
    vi.setSystemTime(new Date('2026-11-25T13:01:00Z'));
    const m2 = makeMentionMessage();
    await hooks.mentionHook!(m2.message);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(m2.reply.mock.calls[0]?.[0]).toContain('-2.1 hPa');
    expect(m2.reply.mock.calls[0]?.[0]).toContain('22:00時点');

    mod.dispose();
  });

  it('現在時刻の予報点欠落は単発なら許容し、連続した場合は失敗として停止バックオフに入る', async () => {
    const staleSeries: HourlyForecast = {
      latitude: 36.32,
      longitude: 139.0,
      elevationM: 100,
      hours: [
        {
          timeLocal: '2026-11-20T00:00',
          pressureMsl: 1012.0,
          temperatureC: 10,
          weatherCode: 0,
        },
      ],
    };
    vi.spyOn(openMeteo, 'fetchForecast').mockResolvedValue(staleSeries);

    const { mod, posts } = createHarness({
      maxErrorRetries: 0,
      updateIntervalMs: 600_000,
      errorCooldownMs: 650_000,
    });
    mod.getHooks();

    // 1回目の不一致は単発として許容（errorCount 0）
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(0);

    // 2回目の連続不一致で errorCount=1 > maxErrorRetries(0) → 1回目の一時停止へ移行
    await vi.advanceTimersByTimeAsync(600_000);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('一時停止しました');

    // クールダウン（650秒）明けの再開初回も consecutiveMissingHours がリセットされているため許容され即再休止しない
    await vi.advanceTimersByTimeAsync(650_000);
    expect(posts).toHaveLength(1);

    // その次の定期評価（さらに連続不一致）で 2 回目の一時停止に入る
    await vi.advanceTimersByTimeAsync(550_000);
    expect(posts).toHaveLength(2);

    mod.dispose();
  });

  it('通信失敗を挟んだ時刻不一致は連続扱いせず、実際に2回連続した時点で停止判定に進む', async () => {
    const staleSeries: HourlyForecast = {
      latitude: 36.32,
      longitude: 139.0,
      elevationM: 100,
      hours: [
        {
          timeLocal: '2026-11-20T00:00',
          pressureMsl: 1012.0,
          temperatureC: 10,
          weatherCode: 0,
        },
      ],
    };
    const fetchSpy = vi
      .spyOn(openMeteo, 'fetchForecast')
      .mockResolvedValueOnce(staleSeries) // 1回目: 時刻不一致 (consecutive=1, errorCount=0)
      .mockRejectedValueOnce(new Error('network error')) // 2回目: 通信失敗 (consecutive=0, errorCount=1 <= 1)
      .mockResolvedValueOnce(staleSeries) // 3回目: 時刻不一致 (単発扱い consecutive=1, errorCount=1 のまま)
      .mockResolvedValueOnce(staleSeries); // 4回目: 連続時刻不一致 (consecutive=2, errorCount=2 > 1 → 停止)

    const { mod, posts } = createHarness({
      maxErrorRetries: 1,
      updateIntervalMs: 600_000,
    });
    mod.getHooks();

    await vi.advanceTimersByTimeAsync(0); // 1回目
    expect(posts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600_000); // 2回目（通信失敗）
    expect(posts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600_000); // 3回目（通信失敗後の1回目の不一致 → 停止しない）
    expect(posts).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(600_000); // 4回目（2回連続の不一致 → 停止）
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('一時停止しました');

    mod.dispose();
  });

  it('時刻不一致や取得失敗後のメンション再試行も updateIntervalMs でレート制限される', async () => {
    const staleSeries: HourlyForecast = {
      latitude: 36.32,
      longitude: 139.0,
      elevationM: 100,
      hours: [
        {
          timeLocal: '2026-11-20T00:00',
          pressureMsl: 1012.0,
          temperatureC: 10,
          weatherCode: 0,
        },
      ],
    };
    const fetchSpy = vi
      .spyOn(openMeteo, 'fetchForecast')
      .mockResolvedValue(staleSeries);

    const { mod } = createHarness({
      updateIntervalMs: 600_000,
    });
    const hooks = mod.getHooks();
    await vi.advanceTimersByTimeAsync(0); // 起動時の試行 1回
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // updateIntervalMs 未満で複数回メンションされても追加の fetchForecast は走らない
    for (const offsetMs of [1_000, 120_000, 599_000]) {
      vi.setSystemTime(
        new Date(new Date('2026-11-25T11:00:00Z').getTime() + offsetMs)
      );
      const { message, reply } = makeMentionMessage();
      await hooks.mentionHook!(message);
      expect(reply).toHaveBeenCalledWith(
        expect.stringContaining('取得できませんでした'),
        expect.objectContaining({ file: undefined })
      );
    }
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // updateIntervalMs 経過後のメンションで 1 回だけ再試行され、直後のメンションは再び抑制される
    vi.setSystemTime(new Date('2026-11-25T11:10:00Z'));
    const afterInterval1 = makeMentionMessage();
    await hooks.mentionHook!(afterInterval1.message);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date('2026-11-25T11:10:05Z'));
    const afterInterval2 = makeMentionMessage();
    await hooks.mentionHook!(afterInterval2.message);
    expect(fetchSpy).toHaveBeenCalledTimes(2);

    mod.dispose();
  });

  it('updateIntervalMs が 2 時間を超える設定（3時間）でも取得成功から 2 時間経過後のメンションは再取得して新しい予報を返す', async () => {
    // 20:00 JST (11:00Z) に初回取得成功
    const fetchSpy = vi
      .spyOn(openMeteo, 'fetchForecast')
      .mockResolvedValueOnce(
        buildForecastAt(new Date('2026-11-25T11:00:00Z'), -0.8)
      );

    const { mod } = createHarness({
      locationName: '高崎市',
      updateIntervalMs: 10_800_000, // 3時間間隔（> STALE_MS 2時間）
    });
    const hooks = mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    // 22:15 JST (13:15Z): 定期取得前（2時間15分経過）でキャッシュは期限切れだが、前回成功なのでメンションで再取得できる
    vi.setSystemTime(new Date('2026-11-25T13:15:00Z'));
    fetchSpy.mockResolvedValueOnce(
      buildForecastAt(new Date('2026-11-25T13:15:00Z'), -1.9)
    );
    const mention = makeMentionMessage();
    await hooks.mentionHook!(mention.message);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const [replyText, replyOpts] = mention.reply.mock.calls[0] as [
      string,
      { file?: unknown },
    ];
    expect(replyText).toContain('-1.9 hPa');
    expect(replyText).toContain('22:00時点');
    expect(replyOpts.file).toBeDefined();

    mod.dispose();
  });

  it('pressure_msl の欠測（ΔP3h=null）が連続した場合は回復扱いせず監視停止へ移行し、有効値取得後にのみ再開通知を出す', async () => {
    const fetchSpy = vi
      .spyOn(openMeteo, 'fetchForecast')
      .mockImplementation(async () =>
        buildForecastAt(new Date(), null, { currentNull: true })
      );

    const { mod, posts } = createHarness({
      maxErrorRetries: 0,
      updateIntervalMs: 600_000,
      errorCooldownMs: 650_000,
    });
    mod.getHooks();

    // 1回目の欠測は単発として許容
    await vi.advanceTimersByTimeAsync(0);
    expect(posts).toHaveLength(0);

    // 2回目の連続欠測で停止バックオフへ移行
    await vi.advanceTimersByTimeAsync(600_000);
    expect(posts).toHaveLength(1);
    expect(posts[0]).toContain('一時停止しました');

    // クールダウン明け初回もまだ欠測なら「再開しました」を誤投稿しない
    await vi.advanceTimersByTimeAsync(650_000);
    expect(posts).toHaveLength(1);

    // 次の評価で有効な ΔP3h が得られた時点で初めて「再開しました」を投稿する
    fetchSpy.mockImplementation(async () => buildForecastAt(new Date(), -0.6));
    await vi.advanceTimersByTimeAsync(550_000);
    expect(posts).toHaveLength(2);
    expect(posts[1]).toContain('気圧監視を再開しました');

    mod.dispose();
  });

  it('message.reply 失敗時は未作成と確定できる HTTP 4xx のみドライブ画像を削除し、通信断や 5xx では残す', async () => {
    vi.spyOn(openMeteo, 'fetchForecast').mockResolvedValueOnce(
      buildForecastAt(new Date(), -1.1)
    );

    const { mod, api, upload, logs } = createHarness({
      locationName: '高崎市',
    });
    upload
      .mockResolvedValueOnce({
        id: 'file-indeterminate-net',
        name: 'kiatsu.png',
      })
      .mockResolvedValueOnce({
        id: 'file-indeterminate-502',
        name: 'kiatsu.png',
      })
      .mockResolvedValueOnce({ id: 'file-orphan-400', name: 'kiatsu.png' });
    api.mockRejectedValueOnce(new Error('drive delete error'));

    const hooks = mod.getHooks();
    await vi.advanceTimersByTimeAsync(0);

    // 1. 通信切断（statusCode なし）→ 返信が保存済みの可能性があるため削除しない
    const netFail = makeMentionMessage();
    netFail.reply.mockRejectedValueOnce(new Error('socket hang up'));
    await hooks.mentionHook!(netFail.message);
    expect(api).not.toHaveBeenCalled();

    // 2. HTTP 502 → 同様に作成結果が不明なため削除しない
    const gatewayFail = makeMentionMessage();
    gatewayFail.reply.mockRejectedValueOnce(
      Object.assign(new Error('Bad Gateway'), { response: { statusCode: 502 } })
    );
    await hooks.mentionHook!(gatewayFail.message);
    expect(api).not.toHaveBeenCalled();

    // 3. HTTP 400 → サーバー側で拒否されたことが確定しているため削除し、削除失敗もログ化する
    const clientFail = makeMentionMessage();
    clientFail.reply.mockRejectedValueOnce(
      Object.assign(new Error('NO_SUCH_NOTE'), {
        response: { statusCode: 400 },
      })
    );
    await hooks.mentionHook!(clientFail.message);
    await Promise.resolve();

    expect(api).toHaveBeenCalledTimes(1);
    expect(api).toHaveBeenCalledWith('drive/files/delete', {
      fileId: 'file-orphan-400',
    });
    expect(
      logs.some((l) =>
        l.includes('不要になった予報画像の削除に失敗しました: file-orphan-400')
      )
    ).toBe(true);

    mod.dispose();
  });
});
