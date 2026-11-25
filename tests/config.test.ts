import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ConfigError,
  initConfig,
  loadConfig,
  resolveConfig,
} from '../src/config/index.js';
import { formatPressureSettings } from '../src/modules/info/format.js';

const base = {
  host: 'https://example.com/',
  i: 'token',
};

describe('resolveConfig', () => {
  it('normalizes host and derives urls', () => {
    const config = resolveConfig(base);
    expect(config.host).toBe('https://example.com');
    expect(config.apiUrl).toBe('https://example.com/api');
    expect(config.wsUrl).toBe('wss://example.com');
  });

  it('derives ws:// for http hosts', () => {
    const config = resolveConfig({ ...base, host: 'http://localhost:3000' });
    expect(config.wsUrl).toBe('ws://localhost:3000');
  });

  it('migrates legacy [http]/[websocket] user agents', () => {
    const config = resolveConfig({
      ...base,
      http: { userAgent: 'legacy-http' },
      websocket: { userAgent: 'legacy-ws' },
    });
    expect(config.userAgent).toEqual({
      http: 'legacy-http',
      websocket: 'legacy-ws',
    });
  });

  it('rejects missing host/token', () => {
    expect(() => resolveConfig({})).toThrow(ConfigError);
    expect(() => resolveConfig({ host: 'https://example.com' })).toThrow(
      ConfigError
    );
  });

  it('rejects invalid host and probability', () => {
    expect(() => resolveConfig({ ...base, host: 'example.com' })).toThrow(
      ConfigError
    );
    expect(() =>
      resolveConfig({
        ...base,
        gemini: { autoNote: { probability: 1.5 } },
      })
    ).toThrow(ConfigError);
  });

  it('rejects out-of-range maxResults', () => {
    expect(() =>
      resolveConfig({
        ...base,
        exa: { search: { maxResults: 99 } },
        jenkins: { something: true },
      })
    ).toThrow(ConfigError);
  });

  it('accepts in-range maxResults and ignores unknown sections', () => {
    const config = resolveConfig({
      ...base,
      exa: { search: { maxResults: 3 } },
      jenkins: { something: true },
    });
    expect(config.exa?.search?.maxResults).toBe(3);
  });

  it('strips trailing slashes from wsUrl', () => {
    const config = resolveConfig({ ...base, host: 'https://example.com///' });
    expect(config.wsUrl).toBe('wss://example.com');
  });

  it('validates aichat, masterUserId and openai.jsonMode', () => {
    const config = resolveConfig({
      ...base,
      masterUserId: 'uid-1',
      aiProvider: { provider: 'openai', openai: { jsonMode: 'none' } },
      aichat: {
        enabled: true,
        affinity: { ignoreThreshold: -40 },
        wander: {
          enabled: true,
          timelines: ['home', 'hybrid'],
          activeHours: { start: 9, end: 23 },
          replyProbability: 0.35,
          postProbability: 0.25,
        },
        reactionFollowUp: {
          enabled: true,
          minAffinity: 30,
          probability: 0.25,
          delaySeconds: 10,
        },
      },
    });
    expect(config.masterUserId).toBe('uid-1');
    expect(config.aichat?.affinity?.ignoreThreshold).toBe(-40);
    expect(config.aichat?.wander?.timelines).toEqual(['home', 'hybrid']);

    expect(() =>
      resolveConfig({
        ...base,
        aiProvider: { openai: { jsonMode: 'invalid' as never } },
      })
    ).toThrow(ConfigError);

    expect(() =>
      resolveConfig({
        ...base,
        aichat: { affinity: { ignoreThreshold: 10 } },
      })
    ).toThrow(ConfigError);

    expect(() =>
      resolveConfig({
        ...base,
        aichat: { wander: { timelines: ['invalid' as never] } },
      })
    ).toThrow(ConfigError);

    expect(() =>
      resolveConfig({
        ...base,
        aichat: { playbookPath: 'bad\0path' },
      })
    ).toThrow(ConfigError);

    expect(() =>
      resolveConfig({
        ...base,
        masterUserId: 123 as never,
      })
    ).toThrow(ConfigError);
  });

  it('tolerates legacy PR #511 aichat keys without throwing', () => {
    const config = resolveConfig({
      ...base,
      aichat: {
        episodeMemory: { enabled: true },
        moodEngine: { enabled: true },
        tlDiary: { enabled: true },
        proactiveFollowup: { enabled: true },
      } as never,
    });
    expect(config.host).toBe('https://example.com');
  });

  it('keeps kiatsu settings as written (defaults live in the module)', () => {
    const config = resolveConfig({
      ...base,
      kiatsu: {
        enabled: true,
        latitude: 36.3219,
        longitude: 139.0033,
        locationName: '高崎市',
        requestTimeoutMs: 10000,
        updateIntervalMs: 600000,
        alertThresholdHpa: -2.0,
        hysteresisHpa: 0.5,
        maxPostsPerDay: 1,
        maxErrorRetries: 5,
        errorCooldownMs: 3600000,
      },
    });

    expect(config.kiatsu?.latitude).toBe(36.3219);
    expect(config.kiatsu?.longitude).toBe(139.0033);
    expect(config.kiatsu?.locationName).toBe('高崎市');
    expect(config.kiatsu?.alertThresholdHpa).toBe(-2.0);
    expect(config.kiatsu?.hysteresisHpa).toBe(0.5);
    expect(config.kiatsu?.maxPostsPerDay).toBe(1);
  });

  it('leaves kiatsu keys unset instead of injecting defaults', () => {
    const config = resolveConfig({ ...base, kiatsu: { enabled: true } });
    expect(config.kiatsu).toEqual({ enabled: true });
  });

  it('rejects out-of-range kiatsu coordinates', () => {
    for (const coords of [
      { latitude: 90.1 },
      { latitude: -90.1 },
      { longitude: 180.1 },
      { longitude: -180.1 },
      { latitude: '36.3' as never },
    ]) {
      expect(() => resolveConfig({ ...base, kiatsu: { ...coords } })).toThrow(
        ConfigError
      );
    }

    const config = resolveConfig({
      ...base,
      kiatsu: { latitude: 90, longitude: -180 },
    });
    expect(config.kiatsu?.latitude).toBe(90);
    expect(config.kiatsu?.longitude).toBe(-180);
  });

  it('rejects a kiatsu alert threshold that is zero or outside -10..0', () => {
    // 0 は「常時警報」で意味を持たず evaluateAlert が例外にするため弾く
    for (const alertThresholdHpa of [0, 0.1, 2, -10.1]) {
      expect(() =>
        resolveConfig({ ...base, kiatsu: { alertThresholdHpa } })
      ).toThrow(ConfigError);
    }

    // -10 以上 0 未満（開区間）は許可
    for (const alertThresholdHpa of [-0.5, -10, -2.0]) {
      const config = resolveConfig({ ...base, kiatsu: { alertThresholdHpa } });
      expect(config.kiatsu?.alertThresholdHpa).toBe(alertThresholdHpa);
    }
  });

  it('rejects a non-boolean kiatsu.enabled', () => {
    // 文字列 "false" は enabled === false 比較をすり抜けて有効扱いになる
    expect(() =>
      resolveConfig({ ...base, kiatsu: { enabled: 'false' as never } })
    ).toThrow(ConfigError);

    const config = resolveConfig({ ...base, kiatsu: { enabled: false } });
    expect(config.kiatsu?.enabled).toBe(false);
  });

  it('shows kiatsu as running when enabled is unset', () => {
    // モジュールは enabled === false のときだけ停止する（未設定は稼働）。
    // 表示側も同じ扱いにしないと、既存利用者が全員「停止」と誤表示される。
    initConfig(resolveConfig({ ...base, kiatsu: {} }));
    expect(formatPressureSettings()).toContain('✅');
  });

  it('rejects out-of-range kiatsu hysteresis and maxPostsPerDay', () => {
    for (const kiatsu of [
      { hysteresisHpa: -0.1 },
      { hysteresisHpa: 5.1 },
      { maxPostsPerDay: 0 },
      { maxPostsPerDay: 1.5 },
      { maxPostsPerDay: '1' as never },
    ]) {
      expect(() => resolveConfig({ ...base, kiatsu })).toThrow(ConfigError);
    }

    const config = resolveConfig({
      ...base,
      kiatsu: { hysteresisHpa: 0, maxPostsPerDay: 24 },
    });
    expect(config.kiatsu?.hysteresisHpa).toBe(0);
    expect(config.kiatsu?.maxPostsPerDay).toBe(24);
  });

  it('ignores legacy kiatsu keys left in a local config.toml', () => {
    // 移行前の config.toml をそのまま使っても起動できること
    const config = resolveConfig({
      ...base,
      kiatsu: {
        enabled: true,
        latitude: 36.3219,
        longitude: 139.0033,
        locationCode: '13102',
        postIntervalMs: 43200000,
        minPostLevel: 2,
      } as never,
    });
    expect(config.host).toBe('https://example.com');
    expect(config.kiatsu?.latitude).toBe(36.3219);
  });
});

describe('loadConfig', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads and validates a TOML file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-config-'));
    dirs.push(dir);
    const file = join(dir, 'config.toml');
    writeFileSync(
      file,
      'host = "https://example.com"\ni = "token"\nnotingEnabled = true\n',
      'utf8'
    );

    const config = loadConfig(file);
    expect(config.host).toBe('https://example.com');
    expect(config.apiUrl).toBe('https://example.com/api');
    expect(config.notingEnabled).toBe(true);
  });

  it('throws ConfigError when the file is missing', () => {
    expect(() => loadConfig('/nonexistent/config.toml')).toThrow(ConfigError);
  });

  it('throws ConfigError on invalid TOML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-config-'));
    dirs.push(dir);
    const file = join(dir, 'config.toml');
    writeFileSync(file, 'host = ', 'utf8');

    expect(() => loadConfig(file)).toThrow(ConfigError);
  });
});

describe('kiatsu の数値型', () => {
  it('クォートされたミリ秒指定を拒否する', () => {
    // TOML で errorCooldownMs = "3600000" と書くと文字列になり、
    // タイマー計算で例外になって監視が再開できなくなる。
    expect(() =>
      resolveConfig({
        ...base,
        kiatsu: { errorCooldownMs: '3600000' as unknown as number },
      } as Parameters<typeof resolveConfig>[0])
    ).toThrow(/数値で指定してください/);
  });
});

describe('kiatsu の座標指定', () => {
  it('片側だけの座標指定を拒否する', () => {
    // longitude が未指定だと既定値と組み合わされ、意図しない地点になる。
    expect(() =>
      resolveConfig({
        ...base,
        kiatsu: { latitude: 36.3219 },
      } as Parameters<typeof resolveConfig>[0])
    ).toThrow(/両方そろえて/);

    expect(() =>
      resolveConfig({
        ...base,
        kiatsu: { longitude: 139.0033 },
      } as Parameters<typeof resolveConfig>[0])
    ).toThrow(/両方そろえて/);

    expect(() =>
      resolveConfig({
        ...base,
        kiatsu: { latitude: 36.3219, longitude: 139.0033 },
      } as Parameters<typeof resolveConfig>[0])
    ).not.toThrow();
  });
});

describe('廃止キーの後方互換', () => {
  it('旧 postIntervalMs が文字列でも起動を止めない', () => {
    // 旧設定では postIntervalMs = "43200000" のように書かれていた。
    // 廃止キーは無視するのが約束なので、型を理由に起動を失敗させない。
    const config = resolveConfig({
      ...base,
      kiatsu: { postIntervalMs: '43200000', locationCode: '13102' },
    } as unknown as Parameters<typeof resolveConfig>[0]);

    expect(config.kiatsu?.latitude).toBeUndefined();
  });
});

describe('kiatsu のヒステリシス', () => {
  it('解除の境界が 0 以上になる幅を拒否する', () => {
    // しきい値 -2.0 に幅 3.0 を足すと +1.0 になり、気圧が上昇しても
    // 解除されず「下がってきています」と上昇量を投稿しうる。
    expect(() =>
      resolveConfig({
        ...base,
        kiatsu: { alertThresholdHpa: -2, hysteresisHpa: 3 },
      } as Parameters<typeof resolveConfig>[0])
    ).toThrow(/絶対値以下/);

    expect(() =>
      resolveConfig({
        ...base,
        kiatsu: { alertThresholdHpa: -2, hysteresisHpa: 2 },
      } as Parameters<typeof resolveConfig>[0])
    ).not.toThrow();
  });
});

describe('kiatsu の解除境界（既定値を含む）', () => {
  it('しきい値だけを浅く指定しても、既定の幅で境界が 0 を超えたら拒否する', () => {
    // しきい値 -0.2 に既定の幅 0.5 を足すと +0.3 になり、横ばいでも解除されない。
    expect(() =>
      resolveConfig({
        ...base,
        kiatsu: { alertThresholdHpa: -0.2 },
      } as Parameters<typeof resolveConfig>[0])
    ).toThrow(/絶対値以下/);

    expect(() =>
      resolveConfig({
        ...base,
        kiatsu: { alertThresholdHpa: -0.2, hysteresisHpa: 0.2 },
      } as Parameters<typeof resolveConfig>[0])
    ).not.toThrow();
  });
});
