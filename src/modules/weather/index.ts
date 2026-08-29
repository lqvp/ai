import { bindThis } from '@/decorators.js';
import Module from '@/module.js';
import Message from '@/message.js';
import axios from 'axios';
import serifs from '../../serifs.js';
import config from '../../config.js';
import * as mfm from '@/utils/mfm.js';

const OPEN_METEO_API = 'https://api.open-meteo.com/v1/forecast';
const OPEN_METEO_GEOCODING_API = 'https://geocoding-api.open-meteo.com/v1/search';

const DEFAULT_WEATHER_PLACE = config.weatherAutoNotePref ?? 'Tokyo';
const DEFAULT_AUTO_NOTE_HOUR = config.weatherAutoNoteHour ?? 7;
const DAILY_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

// WMO Weather interpretation codes (WW)
// https://open-meteo.com/en/docs
const WMO_CODE_MAP: Record<number, { emoji: string; description: string; serifKey: keyof typeof serifs.weather.autoNote }> = {
	0: { emoji: '☀️', description: '快晴', serifKey: 'sunny' },
	1: { emoji: '🌤️', description: '晴れ', serifKey: 'sunny' },
	2: { emoji: '⛅', description: '一部曇り', serifKey: 'cloudy' },
	3: { emoji: '☁️', description: '曇り', serifKey: 'cloudy' },
	45: { emoji: '🌫️', description: '霧', serifKey: 'cloudy' },
	48: { emoji: '🌫️', description: '霧氷', serifKey: 'cloudy' },
	51: { emoji: '🌦️', description: '軽い霧雨', serifKey: 'rainy' },
	53: { emoji: '🌦️', description: '霧雨', serifKey: 'rainy' },
	55: { emoji: '🌧️', description: '激しい霧雨', serifKey: 'rainy' },
	56: { emoji: '🌨️', description: '軽い着氷性の霧雨', serifKey: 'snowy' },
	57: { emoji: '🌨️', description: '着氷性の霧雨', serifKey: 'snowy' },
	61: { emoji: '☔', description: '小雨', serifKey: 'rainy' },
	63: { emoji: '☔', description: '雨', serifKey: 'rainy' },
	65: { emoji: '☔', description: '激しい雨', serifKey: 'rainy' },
	66: { emoji: '🌨️', description: '軽い着氷性の雨', serifKey: 'snowy' },
	67: { emoji: '🌨️', description: '着氷性の雨', serifKey: 'snowy' },
	71: { emoji: '☃️', description: '小雪', serifKey: 'snowy' },
	73: { emoji: '☃️', description: '雪', serifKey: 'snowy' },
	75: { emoji: '☃️', description: '大雪', serifKey: 'snowy' },
	77: { emoji: '❄️', description: '霧雪', serifKey: 'snowy' },
	80: { emoji: '☔', description: 'にわか雨', serifKey: 'rainy' },
	81: { emoji: '☔', description: '激しいにわか雨', serifKey: 'rainy' },
	82: { emoji: '☔', description: '猛烈なにわか雨', serifKey: 'rainy' },
	85: { emoji: '❄️', description: 'にわか雪', serifKey: 'snowy' },
	86: { emoji: '❄️', description: '激しいにわか雪', serifKey: 'snowy' },
	95: { emoji: '⚡', description: '雷雨', serifKey: 'thunder' },
	96: { emoji: '⛈️', description: '雷雨（雹）', serifKey: 'thunder' },
	99: { emoji: '⛈️', description: '激しい雷雨（雹）', serifKey: 'thunder' },
};

interface GeocodingResult {
	id: number;
	name: string;
	latitude: number;
	longitude: number;
	country?: string;
	admin1?: string;
}

interface WeatherForecast {
	date: string;
	dateLabel: string;
	weatherCode: number;
	tempMax: number | null;
	tempMin: number | null;
}

interface WeatherInfo {
	place: string;
	forecasts: WeatherForecast[];
}

export default class WeatherModule extends Module {
	public readonly name = 'weather';

	@bindThis
	public install() {
		this.scheduleWeatherAutoNote();
		return {
			mentionHook: this.mentionHook,
		};
	}

	private async searchLocation(query: string): Promise<GeocodingResult | null> {
		try {
			const response = await axios.get<{ results?: GeocodingResult[] }>(OPEN_METEO_GEOCODING_API, {
				params: {
					name: query,
					count: 1,
					language: 'ja',
					format: 'json',
				},
				timeout: 10000,
			});
			return response.data.results?.[0] ?? null;
		} catch (e) {
			this.log(`Error searching location ${query}: ${e}`);
			return null;
		}
	}

	private async fetchForecast(lat: number, lon: number): Promise<any> {
		try {
			const response = await axios.get(OPEN_METEO_API, {
				params: {
					latitude: lat,
					longitude: lon,
					daily: 'weathercode,temperature_2m_max,temperature_2m_min',
					timezone: 'auto',
					forecast_days: 3,
				},
				timeout: 10000,
			});
			return response.data;
		} catch (e) {
			this.log(`Error fetching forecast for ${lat},${lon}: ${e}`);
			return null;
		}
	}

	private formatWeatherToMfm(info: WeatherInfo, targetDateLabel?: string): string {
		const forecast = targetDateLabel
			? info.forecasts.find(f => f.dateLabel === targetDateLabel)
			: info.forecasts[0];

		if (!forecast) return serifs.weather.fetchError;

		const wmo = WMO_CODE_MAP[forecast.weatherCode] ?? { emoji: '❓', description: '不明', serifKey: 'other' };
		const title = `${info.place}の${forecast.dateLabel}の天気`;
		
		let body = `<center>
${mfm.bold(title)} ${wmo.emoji}
---
${forecast.dateLabel}の天気は「${mfm.bold(wmo.description)}」みたいですよ！

`;

		if (forecast.tempMax !== null || forecast.tempMin !== null) {
			body += `🌡️ ${mfm.bold('気温')}
最高: ${forecast.tempMax !== null ? mfm.color(`${forecast.tempMax}℃`, 'ff4500') : '?'}
最低: ${forecast.tempMin !== null ? mfm.color(`${forecast.tempMin}℃`, '4169e1') : '?'}

`;
		}

		body += `---
</center>
`;

		const serif = serifs.weather.autoNote[wmo.serifKey] || serifs.weather.autoNote.other;
		body += `${serif}\n`;
		body += serifs.weather.forecast(info.place, forecast.dateLabel, wmo.description, '', ''); // Simplified call

		return body;
	}

	private normalizeDateLabel(dayInput?: string): string {
		if (!dayInput) return '今日';
		if (['明日', 'あした'].includes(dayInput)) return '明日';
		if (['明後日', 'あさって'].includes(dayInput)) return '明後日';
		return '今日';
	}

	private getDateLabel(dateStr: string, timezone: string): string {
		const date = new Date(dateStr);
		const now = new Date();
		
		// Adjust to the timezone of the location if possible, but for simplicity we compare dates
		// This is a rough approximation. Ideally we should use dayjs with timezone.
		// But since we only need Today/Tomorrow/DayAfterTomorrow relative to "now" (server time),
		// and the API returns daily data...
		
		// Let's use a simple logic:
		// The API returns dates in YYYY-MM-DD.
		// We can check if it matches today's date in the requested timezone.
		
		// For now, let's just map index 0, 1, 2 to Today, Tomorrow, DayAfterTomorrow
		// This assumes the API returns data starting from "today" in the requested timezone.
		return '今日'; // Placeholder, will be overwritten by index logic
	}

	private scheduleWeatherAutoNote() {
		const now = new Date();
		const nextRunTime = new Date(now);
		nextRunTime.setHours(DEFAULT_AUTO_NOTE_HOUR, 0, 0, 0);
		if (now >= nextRunTime) {
			nextRunTime.setDate(nextRunTime.getDate() + 1);
		}
		const msUntilNext = nextRunTime.getTime() - now.getTime();

		setTimeout(() => {
			this.postWeatherNoteForAuto(DEFAULT_WEATHER_PLACE);
			setInterval(
				() => this.postWeatherNoteForAuto(DEFAULT_WEATHER_PLACE),
				DAILY_INTERVAL_MS
			);
		}, msUntilNext);
	}

	private async postWeatherNoteForAuto(place: string) {
		const location = await this.searchLocation(place);
		if (!location) {
			this.log(`Location not found for auto-note: ${place}`);
			return;
		}

		const data = await this.fetchForecast(location.latitude, location.longitude);
		if (!data || !data.daily) return;

		const forecast = {
			date: data.daily.time[0],
			dateLabel: '今日',
			weatherCode: data.daily.weathercode[0],
			tempMax: data.daily.temperature_2m_max[0],
			tempMin: data.daily.temperature_2m_min[0],
		};

		const info: WeatherInfo = {
			place: location.name,
			forecasts: [forecast],
		};

		const text = this.formatWeatherToMfm(info);
		this.ai.api('notes/create', { text: text });
	}

	@bindThis
	private async mentionHook(msg: Message) {
		if (!msg.text) return false;

		const match = msg.text.match(
			/(?:天気予報|天気|てんき)[\s　]*(今日|明日|明後日|あした|あさって)?[\s　]*([\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}a-zA-Z0-9]+)?/u
		);
		if (!match) return false;

		let dayInput = match[1]?.trim();
		let placeInput = match[2]?.trim();

		const dateLabel = this.normalizeDateLabel(dayInput);
		const place = placeInput || DEFAULT_WEATHER_PLACE;

		const location = await this.searchLocation(place);
		if (!location) {
			msg.reply(serifs.weather.notFound(place));
			return { reaction: '❌' };
		}

		const data = await this.fetchForecast(location.latitude, location.longitude);
		if (!data || !data.daily) {
			msg.reply(serifs.weather.fetchError);
			return { reaction: '❌' };
		}

		const forecasts: WeatherForecast[] = data.daily.time.map((date: string, index: number) => {
			let label = '今日';
			if (index === 1) label = '明日';
			if (index === 2) label = '明後日';
			
			return {
				date,
				dateLabel: label,
				weatherCode: data.daily.weathercode[index],
				tempMax: data.daily.temperature_2m_max[index],
				tempMin: data.daily.temperature_2m_min[index],
			};
		});

		const info: WeatherInfo = {
			place: location.name,
			forecasts,
		};

		const replyText = this.formatWeatherToMfm(info, dateLabel);
		msg.reply(replyText);
		
		const targetForecast = forecasts.find(f => f.dateLabel === dateLabel);
		const wmo = targetForecast ? WMO_CODE_MAP[targetForecast.weatherCode] : null;
		return { reaction: wmo ? wmo.emoji : '❓' };
	}
}
