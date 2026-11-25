import { afterEach, describe, expect, it } from 'vitest';
import { initConfig } from '../src/config/index.js';
import { resolveConfig } from '../src/config/schema.js';
import { formatPressureSettings } from '../src/modules/info/format.js';

const BASE = {
  host: 'https://example.com/',
  i: 'token',
} as const;

function render(kiatsu: Record<string, unknown>): string {
  initConfig(
    resolveConfig({ ...BASE, kiatsu } as unknown as Parameters<
      typeof resolveConfig
    >[0])
  );
  return formatPressureSettings();
}

describe('/info の気圧設定表示', () => {
  afterEach(() => {
    initConfig(
      resolveConfig({ ...BASE, kiatsu: {} } as unknown as Parameters<
        typeof resolveConfig
      >[0])
    );
  });

  it('地点名を出す', () => {
    const text = render({ locationName: '高崎市' });

    expect(text).toContain('高崎市');
  });

  it('監視地点の座標を公開しない', () => {
    // /info への返信は公開ノートに引き継がれることがあり、正確な座標は
    // 監視地点（自宅の近くなど）を特定する手がかりになる。
    const text = render({
      latitude: 36.3219,
      longitude: 139.0033,
      locationName: '高崎市',
    });

    expect(text).not.toContain('36.3219');
    expect(text).not.toContain('139.0033');
  });

  it('enabled 未設定なら稼働として表示する', () => {
    // 実行時は enabled === false のときだけ停止する。表示が逆だと
    // 既存利用者に「止まっている」と誤解させる。
    const text = render({ locationName: '高崎市' });

    expect(text).toContain('✅');
    expect(text).not.toContain('❌');
  });

  it('kiatsu セクション未定義なら空文字、空白地名は未設定として整形する', () => {
    initConfig(resolveConfig({ ...BASE }));
    expect(formatPressureSettings()).toBe('');

    const text = render({
      enabled: false,
      locationName: '   ',
      alertThresholdHpa: -2.5,
      updateIntervalMs: 300_000,
    });
    expect(text).toContain('❌');
    expect(text).toContain('未設定');
    expect(text).toContain('-2.5 hPa');
    expect(text).toContain('5分');
  });
});
