import config from '@/config.js';
import { bindThis } from '@/decorators.js';
import type Message from '@/message.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { msUntilNextHour } from '@/services/clock.js';
import { WeatherApi } from './api.js';
import { formatWeatherToMfm, weatherEmoji } from './format.js';
import type { RawForecast, WeatherInfo } from './types.js';

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function defaultWeatherPlace(): string {
  return config.weatherAutoNotePref ?? '東京都';
}

function defaultAutoNoteHour(): number {
  return config.weatherAutoNoteHour ?? 7;
}

export default class WeatherModule extends Module {
  public readonly name = 'weather';
  private readonly api = new WeatherApi((message) => this.log(message));

  @bindThis
  public install() {
    void this.api.warmup();
    this.scheduleWeatherAutoNote();

    return {
      mentionHook: this.mentionHook,
    };
  }

  private autoNoteSerif(telop: string): string {
    const serifMap: Record<string, string> = {
      雷: serifs.weather.autoNote.thunder,
      雪: serifs.weather.autoNote.snowy,
      雨: serifs.weather.autoNote.rainy,
      曇: serifs.weather.autoNote.cloudy,
      晴: serifs.weather.autoNote.sunny,
    };
    for (const keyword in serifMap) {
      if (telop.includes(keyword)) {
        return serifMap[keyword];
      }
    }
    return serifs.weather.autoNote.other;
  }

  private scheduleWeatherAutoNote(): void {
    // 実行環境の TZ に依存しないよう、Asia/Tokyo の現在時刻から
    // 次回 HH:00 までの差分を計算する。
    const msUntilNext = msUntilNextHour(defaultAutoNoteHour());

    this.later(msUntilNext, () => {
      void this.postWeatherNoteForAuto(defaultWeatherPlace());
      this.every(DAILY_INTERVAL_MS, () =>
        this.postWeatherNoteForAuto(defaultWeatherPlace())
      );
    });
  }

  private async postWeatherNoteForAuto(place: string): Promise<void> {
    try {
      const areaId = await this.api.getAreaId(place);
      if (!areaId) {
        this.log(`Area ID not found for auto-note: ${place}`);
        return;
      }

      const weatherData = await this.api.fetchWeatherData(areaId);
      if (
        !weatherData ||
        !weatherData.forecasts ||
        weatherData.forecasts.length === 0
      ) {
        this.log(`No forecast data for auto-note: ${place}`);
        return;
      }

      const todayForecast = weatherData.forecasts[0];
      const weatherInfo: WeatherInfo = {
        place: this.api.resolvePlaceName(weatherData),
        dateLabel: todayForecast.dateLabel,
        telop: todayForecast.telop,
        tempMin: todayForecast.temperature?.min?.celsius ?? null,
        tempMax: todayForecast.temperature?.max?.celsius ?? null,
        rain: todayForecast.chanceOfRain ?? null,
        greeting: this.autoNoteSerif(todayForecast.telop),
      };

      if (weatherInfo.tempMin == null && weatherInfo.tempMax == null) {
        weatherInfo.additionalMessage = serifs.weather.noTemp;
      }

      await this.ai.post({ text: formatWeatherToMfm(weatherInfo) });
    } catch (e) {
      this.log(`Error in postWeatherNoteForAuto: ${String(e)}`);
    }
  }

  @bindThis
  private async mentionHook(msg: Message) {
    if (!msg.text) return false;

    const match = msg.text.match(
      /(?:天気予報|天気|てんき)[\s　]*(今日|明日|明後日|あした|あさって)?[\s　]*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-zA-Z0-9]+)?/u
    );
    if (!match) return false;

    const dayInput = match[1]?.trim();
    const placeInput = match[2]?.trim();

    const dateLabel = this.normalizeDateLabel(dayInput);
    const place = placeInput || defaultWeatherPlace();

    const areaId = await this.api.getAreaId(place);
    if (!areaId) {
      await msg.reply(serifs.weather.notFound(place));
      return { reaction: '❌' };
    }

    const weatherData = await this.api.fetchWeatherData(areaId);
    if (!weatherData) {
      await msg.reply(serifs.weather.fetchError);
      return { reaction: '❌' };
    }

    const forecast = weatherData.forecasts.find(
      (f: RawForecast) => f.dateLabel === dateLabel
    );
    if (!forecast) {
      await msg.reply(`${dateLabel}の天気データが見つかりませんでした。`);
      return { reaction: '❌' };
    }

    const weatherInfo: WeatherInfo = {
      place: this.api.resolvePlaceName(weatherData),
      dateLabel: forecast.dateLabel,
      telop: forecast.telop,
      tempMin: forecast.temperature?.min?.celsius ?? null,
      tempMax: forecast.temperature?.max?.celsius ?? null,
      rain: forecast.chanceOfRain ?? null,
    };

    if (weatherInfo.tempMin == null && weatherInfo.tempMax == null) {
      weatherInfo.additionalMessage = serifs.weather.noTemp;
    }

    await msg.reply(formatWeatherToMfm(weatherInfo));
    return { reaction: weatherEmoji(forecast.telop) };
  }

  private normalizeDateLabel(dayInput?: string): string {
    if (!dayInput) return '今日';
    if (['明日', 'あした'].includes(dayInput)) return '明日';
    if (['明後日', 'あさって'].includes(dayInput)) return '明後日';
    return '今日';
  }
}
