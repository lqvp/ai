import { XMLParser } from 'fast-xml-parser';
import { getJson, getText } from '@/http/client.js';
import type { RawWeatherData } from './types.js';

const WEATHER_API_BASE_URL = 'https://weather.tsukumijima.net';
const PRIMARY_AREA_XML_URL = `${WEATHER_API_BASE_URL}/primary_area.xml`;
const FORECAST_API_URL_BASE = `${WEATHER_API_BASE_URL}/api/forecast/city/`;
const JMA_AREA_API_URL = 'https://www.jma.go.jp/bosai/common/const/area.json';

const PREF_MAP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const REQUEST_TIMEOUT_MS = 10_000;

type Cache<T> = { data: T; fetchedAt: number } | null;

/**
 * 天気予報 API との通信と地域名解決。
 *
 * 以前は WeatherModule の中にキャッシュ・XML パース・HTTP 呼び出しが
 * すべて同居していた。
 */
export class WeatherApi {
  private prefMapCache: Cache<Record<string, string>> = null;
  private cityMapCache: Cache<Record<string, string>> = null;

  constructor(private readonly log: (message: string) => void) {}

  public async warmup(): Promise<void> {
    await Promise.all([this.updateWeatherMaps(), this.updateCityMap()]);
  }

  /**
   * 都道府県名 → エリアID のマップを更新する。
   */
  public async updateWeatherMaps(): Promise<void> {
    if (
      this.prefMapCache &&
      Date.now() - this.prefMapCache.fetchedAt < PREF_MAP_CACHE_TTL_MS
    ) {
      return;
    }

    try {
      const xml = await getText(PRIMARY_AREA_XML_URL, {
        timeoutMs: REQUEST_TIMEOUT_MS,
      });
      const parser = new XMLParser({ ignoreAttributes: false });
      const obj = parser.parse(xml);
      const nameToIdMap: Record<string, string> = {};

      const extractAreas = (areas: any[]): void => {
        if (!Array.isArray(areas)) return;

        for (const area of areas) {
          if (area?.name && area?.id) {
            nameToIdMap[String(area.name)] = String(area.id);
          }
          if (area?.children) {
            extractAreas(area.children);
          }
        }
      };

      const primaryArea = obj?.primary_area;
      if (primaryArea?.prefecture) {
        extractAreas(
          Array.isArray(primaryArea.prefecture)
            ? primaryArea.prefecture
            : [primaryArea.prefecture]
        );
      }

      this.prefMapCache = { data: nameToIdMap, fetchedAt: Date.now() };
    } catch (e) {
      this.log(`Error updating weather maps: ${String(e)}`);
    }
  }

  /**
   * 市区町村名 → 正式名 のマップを更新する。
   */
  public async updateCityMap(): Promise<void> {
    if (
      this.cityMapCache &&
      Date.now() - this.cityMapCache.fetchedAt < PREF_MAP_CACHE_TTL_MS
    ) {
      return;
    }

    try {
      const data = await getJson<{
        class20s: Record<string, { name: string }>;
      }>(JMA_AREA_API_URL, { timeoutMs: REQUEST_TIMEOUT_MS });

      const cityMap: Record<string, string> = {};
      for (const code in data.class20s) {
        const fullName = data.class20s[code].name;
        if (!fullName) continue;
        const baseName = fullName.replace(/(市|町|村|区)$/, '');
        if (!cityMap[baseName]) {
          cityMap[baseName] = fullName;
        }
      }

      this.cityMapCache = { data: cityMap, fetchedAt: Date.now() };
    } catch (e) {
      this.log(`Error updating city map: ${String(e)}`);
    }
  }

  public async getAreaId(place: string): Promise<string | undefined> {
    await this.updateWeatherMaps();
    const prefIdMap = this.prefMapCache?.data;
    if (!prefIdMap) {
      this.log('Prefecture ID map is not available.');
      return undefined;
    }

    // 完全一致
    if (prefIdMap[place]) return prefIdMap[place];

    // 接尾辞なしで一致
    const placeWithoutSuffix = place.replace(/(都|府|県)$/, '');
    if (prefIdMap[placeWithoutSuffix]) return prefIdMap[placeWithoutSuffix];

    // 接尾辞を補って一致
    if (!/(都|府|県)$/.test(place)) {
      if (prefIdMap[`${place}都`]) return prefIdMap[`${place}都`];
      if (prefIdMap[`${place}府`]) return prefIdMap[`${place}府`];
      if (prefIdMap[`${place}県`]) return prefIdMap[`${place}県`];
    }

    return undefined;
  }

  public async fetchWeatherData(
    areaId: string
  ): Promise<RawWeatherData | null> {
    try {
      const weatherData = await getJson<RawWeatherData>(
        `${FORECAST_API_URL_BASE}${areaId}`,
        { timeoutMs: REQUEST_TIMEOUT_MS }
      );

      if (weatherData?.error) {
        this.log(
          `Weather API error for areaId ${areaId}: ${weatherData.error}`
        );
        return null;
      }
      if (!weatherData?.forecasts || !weatherData?.location) {
        this.log(
          `Invalid weather data received: ${JSON.stringify(weatherData)}`
        );
        return null;
      }
      return weatherData;
    } catch (e) {
      this.log(
        `Error fetching weather data for areaId ${areaId}: ${String(e)}`
      );
      return null;
    }
  }

  /**
   * API レスポンスから表示用の地名を組み立てる。
   */
  public resolvePlaceName(weatherData: RawWeatherData): string {
    const city = weatherData.location?.city;
    const fullCityName = city ? this.cityMapCache?.data?.[city] : null;

    if (weatherData.location?.prefecture && fullCityName) {
      return `${weatherData.location.prefecture} ${fullCityName}`;
    }
    if (weatherData.location?.prefecture && city) {
      return `${weatherData.location.prefecture} ${city}`;
    }
    return weatherData.title?.replace(/ の天気$/, '') ?? city ?? '';
  }
}
