import { createCanvas, loadImage } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import type {
  HourlyForecast,
  HourlyPoint,
} from '../src/modules/kiatsu/open-meteo.js';
import { renderKiatsuImage } from '../src/modules/kiatsu/render-kiatsu.js';

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8)).toEqual(PNG_SIGNATURE);
  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
  };
}

function makeHours(count: number, basePressure = 1015.0): HourlyPoint[] {
  const weatherCodes = [0, 1, 2, 3, 45, 51, 61, 71, 77, 80, 95, 999];
  return Array.from({ length: count }, (_, i) => {
    const day = 25 + Math.floor(i / 24);
    const hour = String(i % 24).padStart(2, '0');
    return {
      timeLocal: `2026-11-${String(day).padStart(2, '0')}T${hour}:00`,
      pressureMsl: Number((basePressure - i * 0.4).toFixed(1)),
      temperatureC: 12 - i * 0.5,
      weatherCode: weatherCodes[i % weatherCodes.length],
    };
  });
}

describe('renderKiatsuImage', () => {
  it('generates a valid 12-column PNG across all WMO weather categories including fog and thunder', () => {
    const forecast: HourlyForecast = {
      latitude: 36.3219,
      longitude: 139.0033,
      elevationM: 101,
      hours: makeHours(18),
    };

    const png = renderKiatsuImage(forecast, {
      locationName: '高崎市',
      startIndex: 3,
      thresholdHpa: -2.0,
      fetchedAtLocal: '2026-11-25T20:58',
      nowLocal: '2026-11-25T03:00',
    });

    expect(readPngDimensions(png)).toEqual({ width: 1336, height: 568 });
  });

  it('handles degenerate inputs (empty hours, all-null points, out-of-range startIndex, invalid threshold)', () => {
    const emptyPng = renderKiatsuImage({
      latitude: 35.67,
      longitude: 139.77,
      elevationM: null,
      hours: [],
    });
    expect(readPngDimensions(emptyPng)).toEqual({ width: 1336, height: 568 });

    const allNulls: HourlyPoint[] = Array.from({ length: 5 }, (_, i) => ({
      timeLocal: `2026-11-25T0${i}:00`,
      pressureMsl: null,
      temperatureC: null,
      weatherCode: null,
    }));
    const nullPng = renderKiatsuImage(
      { latitude: 35.67, longitude: 139.77, elevationM: null, hours: allNulls },
      { startIndex: 999, thresholdHpa: 0, fetchedAtLocal: 'invalid' }
    );
    expect(readPngDimensions(nullPng)).toEqual({ width: 1336, height: 568 });
  });

  it('stacks the footer into 2 lines when maxColumns is narrow so text does not collide', () => {
    const png = renderKiatsuImage(
      {
        latitude: 36.32,
        longitude: 139.0,
        elevationM: 100,
        hours: makeHours(8),
      },
      {
        maxColumns: 4,
        locationName:
          '北海道札幌市中央区北一条西二丁目付近のとても長い地点名テスト',
        startIndex: 3,
        nowLocal: '2026-11-20T00:00',
        fetchedAtLocal: '2026-11-25T03:45',
      }
    );

    // 4列: width = 32*2 + 18*2 + 132 + 4*92 = 600, stackFooter = true で height = 588
    expect(readPngDimensions(png)).toEqual({ width: 600, height: 588 });
  });

  it('colors 0.1 hPa floating-point boundary drops (-2.0 and -1.0) consistently with alert evaluation', async () => {
    // 1022.1 - 1024.1 = -1.9999999999998863（表示 -2.0 → 赤 #ffc4c4 = rgb(255,196,196)）
    // 1023.1 - 1024.1 = -0.9999999999998863（表示 -1.0 → 黄 #ffe9b8 = rgb(255,233,184)）
    const hours: HourlyPoint[] = [
      {
        timeLocal: '2026-11-25T00:00',
        pressureMsl: 1024.1,
        temperatureC: 10,
        weatherCode: 0,
      },
      {
        timeLocal: '2026-11-25T01:00',
        pressureMsl: 1024.1,
        temperatureC: 10,
        weatherCode: 0,
      },
      {
        timeLocal: '2026-11-25T02:00',
        pressureMsl: 1024.1,
        temperatureC: 10,
        weatherCode: 0,
      },
      {
        timeLocal: '2026-11-25T03:00',
        pressureMsl: 1022.1,
        temperatureC: 10,
        weatherCode: 0,
      },
      {
        timeLocal: '2026-11-25T04:00',
        pressureMsl: 1023.1,
        temperatureC: 10,
        weatherCode: 0,
      },
    ];

    const png = renderKiatsuImage(
      { latitude: 35.67, longitude: 139.77, elevationM: 10, hours },
      { startIndex: 3, thresholdHpa: -2.0 }
    );

    const img = await loadImage(png);
    const canvas = createCanvas(img.width, img.height);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0);

    // drop 行の先頭バッジ（column 0: x = 50 + 132 + 9 = 191, y = 50 + 88 + 58 + 76 + 60 + 68 + 12 = 412）の左上内側をサンプリング
    const col0Pixel = ctx.getImageData(198, 418, 1, 1).data;
    expect([col0Pixel[0], col0Pixel[1], col0Pixel[2]]).toEqual([255, 196, 196]);

    // column 1 バッジ（x = 191 + 92 = 283）の左上内側
    const col1Pixel = ctx.getImageData(290, 418, 1, 1).data;
    expect([col1Pixel[0], col1Pixel[1], col1Pixel[2]]).toEqual([255, 233, 184]);
  });
});
