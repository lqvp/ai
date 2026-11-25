import { describe, expect, it, vi } from 'vitest';
import * as httpClient from '../src/http/client.js';
import {
  buildQuery,
  DEFAULT_FORECAST_DAYS,
  DEFAULT_PAST_DAYS,
  fetchForecast,
  OPEN_METEO_FORECAST_URL,
  parseForecast,
} from '../src/modules/kiatsu/open-meteo.js';

/** Open-Meteo の応答を最小限まねた payload。テストごとに必要な所だけ差し替える。 */
function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    latitude: 35.6875,
    longitude: 139.6875,
    elevation: 40,
    hourly: {
      time: [
        '2026-11-25T20:00',
        '2026-11-25T21:00',
        '2026-11-25T22:00',
        '2026-11-25T23:00',
      ],
      pressure_msl: [1012.3, 1012.1, 1011.8, 1011.4],
      temperature_2m: [12.1, 11.8, 11.5, 11.2],
      weather_code: [1, 1, 2, 3],
    },
    ...overrides,
  };
}

describe('parseForecast', () => {
  it('maps a valid payload hour by hour', () => {
    const forecast = parseForecast(makePayload());

    expect(forecast.latitude).toBe(35.6875);
    expect(forecast.longitude).toBe(139.6875);
    expect(forecast.elevationM).toBe(40);
    expect(forecast.hours).toHaveLength(4);
    expect(forecast.hours[0]).toEqual({
      timeLocal: '2026-11-25T20:00',
      pressureMsl: 1012.3,
      temperatureC: 12.1,
      weatherCode: 1,
    });
    expect(forecast.hours[3]).toEqual({
      timeLocal: '2026-11-25T23:00',
      pressureMsl: 1011.4,
      temperatureC: 11.2,
      weatherCode: 3,
    });
  });

  it('keeps missing values as null and does not turn 0 into null', () => {
    const forecast = parseForecast(
      makePayload({
        hourly: {
          time: ['2026-11-26T00:00', '2026-11-26T01:00', '2026-11-26T02:00'],
          pressure_msl: [1009.5, null, 1008.2],
          temperature_2m: [0, -0.4, 3],
          weather_code: [0, null, 61],
        },
      })
    );

    expect(forecast.hours).toEqual([
      {
        timeLocal: '2026-11-26T00:00',
        pressureMsl: 1009.5,
        temperatureC: 0,
        weatherCode: 0,
      },
      {
        timeLocal: '2026-11-26T01:00',
        pressureMsl: null,
        temperatureC: -0.4,
        weatherCode: null,
      },
      {
        timeLocal: '2026-11-26T02:00',
        pressureMsl: 1008.2,
        temperatureC: 3,
        weatherCode: 61,
      },
    ]);
  });

  it('normalizes NaN and non-number values to null', () => {
    const forecast = parseForecast(
      makePayload({
        hourly: {
          time: ['2026-11-26T00:00', '2026-11-26T01:00'],
          pressure_msl: [Number.NaN, '1010.0'],
          temperature_2m: [undefined, 5],
          weather_code: [Infinity, 3],
        },
      })
    );

    expect(forecast.hours[0]).toEqual({
      timeLocal: '2026-11-26T00:00',
      pressureMsl: null,
      temperatureC: null,
      weatherCode: null,
    });
    expect(forecast.hours[1].pressureMsl).toBeNull();
    expect(forecast.hours[1].temperatureC).toBe(5);
  });

  it('sets elevationM to null when elevation is absent', () => {
    const payload = makePayload();
    const withoutElevation: Record<string, unknown> = { ...payload };
    delete withoutElevation.elevation;

    const forecast = parseForecast(withoutElevation);

    expect(forecast.elevationM).toBeNull();
    expect(forecast.hours).toHaveLength(4);
  });

  it('throws when hourly.time is missing', () => {
    expect(() =>
      parseForecast(
        makePayload({
          hourly: {
            pressure_msl: [1012.3],
            temperature_2m: [12.1],
            weather_code: [1],
          },
        })
      )
    ).toThrow('Open-Meteo: hourly.time is missing');

    expect(() => parseForecast(makePayload({ hourly: { time: [] } }))).toThrow(
      'Open-Meteo: hourly.time is missing'
    );
  });

  it('throws when a series length does not match hourly.time', () => {
    expect(() =>
      parseForecast(
        makePayload({
          hourly: {
            time: ['2026-11-25T20:00', '2026-11-25T21:00'],
            pressure_msl: [1012.3],
            temperature_2m: [12.1, 11.8],
            weather_code: [1, 1],
          },
        })
      )
    ).toThrow('pressure_msl length 1 does not match hourly.time length 2');

    expect(() =>
      parseForecast(
        makePayload({
          hourly: {
            time: ['2026-11-25T20:00', '2026-11-25T21:00'],
            pressure_msl: [1012.3, 1012.1],
            temperature_2m: [12.1, 11.8, 11.5],
            weather_code: [1, 1],
          },
        })
      )
    ).toThrow('temperature_2m length 3 does not match hourly.time length 2');
  });

  it('throws when a series is missing entirely', () => {
    expect(() =>
      parseForecast(
        makePayload({
          hourly: {
            time: ['2026-11-25T20:00'],
            temperature_2m: [12.1],
            weather_code: [1],
          },
        })
      )
    ).toThrow('hourly.pressure_msl is missing');
  });

  it('throws when coordinates are not numbers', () => {
    expect(() => parseForecast(makePayload({ latitude: '35.68' }))).toThrow(
      'Open-Meteo: latitude is missing or not a number'
    );
    expect(() => parseForecast(makePayload({ longitude: undefined }))).toThrow(
      'Open-Meteo: longitude is missing or not a number'
    );
  });
});

describe('buildQuery', () => {
  it('pins jma_msm and Asia/Tokyo with the documented defaults', () => {
    const query = buildQuery({ latitude: 35.68, longitude: 139.77 });

    expect(query).toEqual({
      latitude: '35.68',
      longitude: '139.77',
      hourly: 'pressure_msl,temperature_2m,weather_code',
      timezone: 'Asia/Tokyo',
      models: 'jma_msm',
      past_days: String(DEFAULT_PAST_DAYS),
      forecast_days: String(DEFAULT_FORECAST_DAYS),
    });
    expect(DEFAULT_PAST_DAYS).toBe(1);
    expect(DEFAULT_FORECAST_DAYS).toBe(4);
    // pressure_msl は標高非依存なので elevation は要求しない
    expect(query).not.toHaveProperty('elevation');
  });

  it('lets callers override the day ranges', () => {
    const query = buildQuery({
      latitude: 35,
      longitude: 139,
      pastDays: 0,
      forecastDays: 2,
    });

    expect(query.past_days).toBe('0');
    expect(query.forecast_days).toBe('2');
  });
});

describe('fetchForecast & additional edge cases', () => {
  it('accepts equator / prime meridian (0, 0) coordinates', () => {
    const forecast = parseForecast(makePayload({ latitude: 0, longitude: 0 }));
    expect(forecast.latitude).toBe(0);
    expect(forecast.longitude).toBe(0);
  });

  it('calls getJson with expected URL, query and timeout, and extracts HTTP 400 reason', async () => {
    const spy = vi
      .spyOn(httpClient, 'getJson')
      .mockResolvedValueOnce(makePayload());

    const result = await fetchForecast({
      latitude: 36.32,
      longitude: 139.0,
      timeoutMs: 5000,
    });
    expect(result.hours).toHaveLength(4);
    expect(spy).toHaveBeenCalledWith(OPEN_METEO_FORECAST_URL, {
      searchParams: expect.objectContaining({
        latitude: '36.32',
        longitude: '139',
        models: 'jma_msm',
      }),
      timeoutMs: 5000,
    });

    spy.mockRejectedValueOnce({
      response: {
        statusCode: 400,
        body: JSON.stringify({
          error: true,
          reason: 'No data is available for this location',
        }),
      },
    });
    await expect(fetchForecast({ latitude: 0, longitude: 0 })).rejects.toThrow(
      'Open-Meteo HTTP 400: No data is available for this location'
    );

    spy.mockRestore();
  });
});
