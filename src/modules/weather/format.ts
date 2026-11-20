import serifs from '@/serifs.js';
import * as mfm from '@/utils/mfm.js';
import type { RainChance, WeatherForecast } from './types.js';

const CLOSING_MESSAGES = [
  '今日も素敵な一日になりますように♪ ✨',
  '良い一日をお過ごしくださいね！ 😊',
  '何か良いことがありますように！ 🍀',
  '頑張ってくださいね！応援しています！ 💪',
  '無理せず、自分のペースでいきましょう。☕',
];

function getRainProbabilityColor(probability: number): string {
  if (probability === 0) return '32cd32'; // 0% (緑)
  if (probability <= 20) return '6495ed'; // 1-20% (明るい青)
  if (probability <= 50) return 'ffa500'; // 21-50% (オレンジ)
  return 'ff4500'; // 51%以上 (赤)
}

function formatTempBlock(forecast: WeatherForecast): string {
  const max =
    forecast.tempMax !== null ? `${Math.round(forecast.tempMax)}℃` : '?';
  const min =
    forecast.tempMin !== null ? `${Math.round(forecast.tempMin)}℃` : '?';
  return `🌡️ ${mfm.bold('気温')}
最高: ${mfm.color(max, 'ff4500')}
最低: ${mfm.color(min, '4169e1')}`;
}

function formatRainBlock(rain: RainChance): string {
  const rows: string[] = [];
  for (const [label, value] of [
    ['0-6時', rain.T00_06],
    ['6-12時', rain.T06_12],
    ['12-18時', rain.T12_18],
    ['18-24時', rain.T18_24],
  ] as const) {
    // データがない区間は 0% と区別するため「-」で表示する
    const text = value === null ? '-' : `${value}%`;
    const color = value === null ? '777777' : getRainProbabilityColor(value);
    rows.push(`${label}:${mfm.color(text, color)}`);
  }
  return `☔ ${mfm.bold('降水確率')}
${rows.join('\n')}`;
}

/**
 * 天気予報を Misskey の MFM 文字列へ整形する。
 */
export function formatWeatherToMfm(
  place: string,
  forecast: WeatherForecast,
  greeting: string
): string {
  const title = `${place}の${forecast.dateLabel}の天気`;

  let body = `<center>
${mfm.bold(title)} ${forecast.weather.emoji}
---
${forecast.dateLabel}の天気は「${mfm.bold(forecast.weather.description)}」みたいですよ！

`;

  if (forecast.tempMax !== null || forecast.tempMin !== null) {
    body += `${formatTempBlock(forecast)}

`;
  } else {
    body += `${serifs.weather.noTemp}

`;
  }

  if (forecast.rain) {
    body += `${formatRainBlock(forecast.rain)}

`;
  }

  body += `---
</center>
`;

  if (greeting) {
    body += `${greeting}\n`;
  }

  body += CLOSING_MESSAGES[Math.floor(Math.random() * CLOSING_MESSAGES.length)];

  // Open-Meteo のライセンスにより出典のクレジットが求められる
  body += `\n[Weather data by Open-Meteo.com](https://open-meteo.com/)`;

  return body;
}
