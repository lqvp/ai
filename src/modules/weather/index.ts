import config from '@/config/index.js';
import { bindThis } from '@/decorators.js';
import type Message from '@/message.js';
import Module from '@/module.js';
import serifs from '@/serifs.js';
import { msUntilNextHour } from '@/services/clock.js';
import { WeatherApi } from './api.js';
import { formatWeatherToMfm } from './format.js';

const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

function defaultWeatherPlace(): string {
  return config.weatherAutoNotePref ?? '東京都';
}

function defaultAutoNoteHour(): number {
  return config.weatherAutoNoteHour ?? 7;
}

function normalizeDateLabel(dayInput?: string): string {
  if (!dayInput) return '今日';
  if (['明日', 'あした'].includes(dayInput)) return '明日';
  if (['明後日', 'あさって'].includes(dayInput)) return '明後日';
  return '今日';
}

export default class WeatherModule extends Module {
  public readonly name = 'weather';
  private readonly api = new WeatherApi((message) => this.log(message));

  @bindThis
  public install() {
    this.scheduleWeatherAutoNote();

    return {
      mentionHook: this.mentionHook,
    };
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
      const location = await this.api.searchLocation(place);
      if (!location) {
        this.log(`Location not found for auto-note: ${place}`);
        return;
      }

      const forecasts = await this.api.fetchDailyForecasts(
        location.latitude,
        location.longitude
      );
      if (forecasts.length === 0) {
        this.log(`No forecast data for auto-note: ${place}`);
        return;
      }

      const today = forecasts[0];
      const text = formatWeatherToMfm(
        { place: location.name, forecasts },
        today,
        serifs.weather.autoNote[today.weather.serifKey]
      );
      await this.ai.post({ text });
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

    const dateLabel = normalizeDateLabel(match[1]?.trim());
    const place = match[2]?.trim() || defaultWeatherPlace();

    let location;
    try {
      location = await this.api.searchLocation(place);
    } catch (e) {
      this.log(`Failed to search location ${place}: ${String(e)}`);
      await msg.reply(serifs.weather.fetchError);
      return { reaction: '❌' };
    }
    if (!location) {
      await msg.reply(serifs.weather.notFound(place));
      return { reaction: '❌' };
    }

    const forecasts = await this.api.fetchDailyForecasts(
      location.latitude,
      location.longitude
    );
    const forecast = forecasts.find((f) => f.dateLabel === dateLabel);
    if (forecasts.length === 0 || !forecast) {
      await msg.reply(serifs.weather.fetchError);
      return { reaction: '❌' };
    }

    const text = formatWeatherToMfm(
      { place: location.name, forecasts },
      forecast,
      ''
    );
    await msg.reply(text);
    return { reaction: forecast.weather.emoji };
  }
}
