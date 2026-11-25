import { describe, expect, it } from 'vitest';
import {
  ATTRIBUTION,
  buildAlertMessage,
  buildMentionMessage,
  describeDelta,
} from '../src/modules/kiatsu/messages.js';

describe('気圧投稿の文面', () => {
  it('出典表示に提供元とライセンスのリンクを含む', () => {
    // CC-BY 4.0 は出典の明示に加えてライセンスと提供元へのリンクを求める。
    expect(ATTRIBUTION).toContain('open-meteo.com');
    expect(ATTRIBUTION).toContain('creativecommons.org/licenses/by/4.0');
    expect(ATTRIBUTION).toContain('Open-Meteo');
  });

  it('変化量を符号付き小数1桁で述べる', () => {
    expect(describeDelta(-2.34)).toBe('直近3時間で -2.3 hPa');
    expect(describeDelta(0)).toBe('直近3時間で 0.0 hPa');
    expect(describeDelta(0.04)).toBe('直近3時間で 0.0 hPa');
    expect(describeDelta(1.25)).toBe('直近3時間で +1.3 hPa');
  });

  it('警報文に地点・変化量・出典を含む', () => {
    const text = buildAlertMessage('高崎市', -2.3);

    expect(text).toContain('高崎市');
    expect(text).toContain('-2.3 hPa');
    expect(text).toContain(ATTRIBUTION);
  });

  it('警報文にレベルの語彙と頭痛の因果を書かない', () => {
    // 警戒レベルは式が非公開で検証できないため語彙ごと廃止した。
    // 頭痛への因果も、こちらには根拠がない。
    const text = buildAlertMessage('高崎市', -3.1);

    expect(text).not.toContain('レベル');
    expect(text).not.toContain('警戒');
    expect(text).not.toContain('頭痛');
  });

  it('メンション返信に観測時刻を添えられる', () => {
    const text = buildMentionMessage('高崎市', -1.8, '2026-11-25T20:00');

    expect(text).toContain('高崎市');
    expect(text).toContain('-1.8 hPa');
    expect(text).toContain('20:00時点');
    expect(text).toContain('hPa 変化しています');
    expect(text).toContain(ATTRIBUTION);
  });

  it('データが無いときは数値を出さず、出典も付けない', () => {
    const text = buildMentionMessage('高崎市', null);

    expect(text).toContain('取得できませんでした');
    expect(text).not.toContain('hPa');
    expect(text).not.toContain(ATTRIBUTION);
  });

  it('予報画像を添付しつつ 3時間変化だけ欠測のときは欠測説明と出典 URL を両方出す', () => {
    const text = buildMentionMessage('高崎市', null, '2026-11-25T20:00', {
      hasForecastImage: true,
    });

    expect(text).toContain('高崎市付近');
    expect(text).toContain('欠測');
    expect(text).toContain('20:00時点');
    expect(text).toContain(ATTRIBUTION);
  });

  it('locationName 未設定時は座標を出さず自然な日本語にする', () => {
    const alertText = buildAlertMessage(undefined, -2.4);
    expect(alertText).toContain(
      '気圧が下がってきています（直近3時間で -2.4 hPa）。'
    );
    expect(alertText).not.toContain('undefined');

    const mentionText = buildMentionMessage('', -1.2, '2026-11-25T20:00');
    expect(mentionText).toContain(
      '気圧は直近3時間で -1.2 hPa 変化しています（20:00時点）。'
    );
  });
});
