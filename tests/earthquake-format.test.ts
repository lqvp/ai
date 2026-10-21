import { describe, expect, it } from 'vitest';
import {
  convertIntensityDisplay,
  convertIntensityToNumber,
  convertTsunamiGrade,
  formatJSTDateTime,
  formatP2PDateTime,
  formatTsunamiArea,
  generateEarthquakeMessage,
  generateTsunamiMessage,
  randomChoice,
} from '../src/modules/earthquake_warning/format.js';
import type { WolfxEarthquakeData } from '../src/modules/earthquake_warning/types.js';

const quake: WolfxEarthquakeData = {
  type: 'jma_eew',
  Title: '緊急地震速報',
  CodeType: 'Detail',
  Issue: { Source: '気象庁', Status: '通常' },
  EventID: '20260101000000',
  Serial: 1,
  AnnouncedTime: '2026-01-01T00:00:00+09:00',
  OriginTime: '2026-01-01T00:00:00+09:00',
  Hypocenter: '千葉県北西部',
  Latitude: 35.5,
  Longitude: 140,
  Magunitude: 5.2,
  Depth: 60,
  MaxIntensity: '4',
  Accuracy: { Epicenter: '±10km', Depth: '±10km', Magnitude: '±0.2' },
  isSea: false,
  isTraining: false,
  isAssumption: false,
  isWarn: false,
  isFinal: false,
  isCancel: false,
  OriginalText: '',
};

describe('earthquake intensity helpers', () => {
  it('converts intensity strings to numbers', () => {
    expect(convertIntensityToNumber('7')).toBe(7);
    expect(convertIntensityToNumber('6-')).toBe(6);
    expect(convertIntensityToNumber('6強')).toBe(6);
    expect(convertIntensityToNumber('5+')).toBe(5);
    expect(convertIntensityToNumber('')).toBe(0);
  });

  it('converts +/- to 弱/強', () => {
    expect(convertIntensityDisplay('5-')).toBe('5弱');
    expect(convertIntensityDisplay('6+')).toBe('6強');
    expect(convertIntensityDisplay('4')).toBe('4');
  });

  it('converts tsunami grades', () => {
    expect(convertTsunamiGrade('MajorWarning')).toBe('大津波警報');
    expect(convertTsunamiGrade('Warning')).toBe('津波警報');
    expect(convertTsunamiGrade('Watch')).toBe('津波注意報');
    expect(convertTsunamiGrade(undefined)).toBe('不明');
  });

  it('formats dates in JST', () => {
    expect(formatJSTDateTime(new Date('2026-01-01T00:00:00Z'))).toContain(
      '09:00:00'
    );
    expect(formatP2PDateTime('invalid')).toBe('invalid JST');
  });

  it('picks deterministic items', () => {
    expect(randomChoice(['a'])).toBe('a');
  });
});

describe('earthquake messages', () => {
  it('formats a tsunami advisory', () => {
    const text = generateTsunamiMessage({
      id: '1',
      code: 551,
      time: '2026-01-01T00:00:00+09:00',
      cancelled: false,
      issue: {
        source: '気象庁',
        time: '2026-01-01T00:00:00+09:00',
        type: '発表',
      },
      areas: [
        { grade: 'Warning', name: '伊豆諸島', immediate: true },
        { grade: 'Watch', name: '小笠原諸島' },
      ],
    });
    expect(text).toContain('津波警報 1地域');
    expect(text).toContain('伊豆諸島');
    expect(text).toContain('直ちに津波来襲');
  });

  it('formats a cancellation', () => {
    const text = generateTsunamiMessage({
      id: '2',
      code: 552,
      time: '2026-01-01T00:00:00+09:00',
      cancelled: true,
      issue: { time: '2026-01-01T00:00:00+09:00', type: '解除' },
    });
    expect(text).toContain('解除されました');
  });

  it('formats a first earthquake report', () => {
    const text = generateEarthquakeMessage(quake, true);
    expect(text).toContain('千葉県北西部付近で震度4');
    expect(text).toContain('マグニチュードは5.2');
    expect(text).toContain('震源の深さは約60km');
  });

  it('shows update deltas against previous report', () => {
    const previous = { ...quake, Magunitude: 4.8, Depth: 50 };
    const text = generateEarthquakeMessage(
      { ...quake, MaxIntensity: '5-' },
      false,
      previous
    );
    expect(text).toContain('マグニチュード: 4.8 → 5.2');
    expect(text).toContain('震源の深さ: 50km → 60km');
    expect(text).toContain('震度: 4 → 5弱');
  });

  it('formats warn areas', () => {
    const text = generateEarthquakeMessage(
      {
        ...quake,
        WarnArea: [
          {
            Chiiki: '千葉県北西部',
            Shindo1: '4',
            Shindo2: '5-',
            Time: '2026-01-01T00:00:00+09:00',
            Type: '予想',
            Arrive: true,
          },
        ],
      },
      true
    );
    expect(text).toContain('千葉県北西部: 震度4～5弱 (予想)');
  });

  it('formats tsunami areas with height details', () => {
    expect(
      formatTsunamiArea({
        name: '相模湾',
        grade: 'MajorWarning',
        immediate: true,
        firstHeight: { condition: '到達中' },
        maxHeight: { value: 3 },
      })
    ).toBe('相模湾 (大津波警報) 直ちに津波来襲と予測 / 到達中 / 予想高さ: 3m');
  });
});
