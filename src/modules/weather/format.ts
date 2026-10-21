import * as mfm from '@/utils/mfm.js';
import type { WeatherInfo } from './types.js';

const WEATHER_EMOJI_MAP: Record<string, string> = {
  晴: '☀️',
  曇: '☁️',
  雨: '☔',
  雪: '⛄',
  雷: '⚡',
};

const DEFAULT_WEATHER_EMOJI = '🌈';

const WEATHER_THEME_COLOR_MAP: Record<string, string> = {
  晴: 'ffd700',
  曇: 'a9a9a9',
  雨: '4682b4',
  雪: 'f0f8ff',
  雷: '9370db',
};

const DEFAULT_THEME_COLOR = '777777';

export function weatherEmoji(telop: string): string {
  for (const keyword in WEATHER_EMOJI_MAP) {
    if (telop.includes(keyword)) {
      return WEATHER_EMOJI_MAP[keyword];
    }
  }
  return DEFAULT_WEATHER_EMOJI;
}

function getRainProbabilityColor(probability: string): string {
  const probNum = Number.parseInt(probability.replace('%', ''), 10);
  if (Number.isNaN(probNum)) return '777777';
  if (probNum === 0) return '32cd32';
  if (probNum <= 20) return '6495ed';
  if (probNum <= 50) return 'ffa500';
  return 'ff4500';
}

function getWeatherThemeColor(telop: string): string {
  for (const keyword in WEATHER_THEME_COLOR_MAP) {
    if (telop.includes(keyword)) {
      return WEATHER_THEME_COLOR_MAP[keyword];
    }
  }
  return DEFAULT_THEME_COLOR;
}

const CLOSING_MESSAGES = [
  '今日も素敵な一日になりますように♪ ✨',
  '良い一日をお過ごしくださいね！ 😊',
  '何か良いことがありますように！ 🍀',
  '頑張ってくださいね！応援しています！ 💪',
  '無理せず、自分のペースでいきましょう。☕',
];

/**
 * 天気情報を Misskey の MFM 文字列へ整形する。
 */
export function formatWeatherToMfm(info: WeatherInfo): string {
  const themeColor = getWeatherThemeColor(info.telop);
  const title = `${info.place}の${info.dateLabel}の天気`;
  const emoji = weatherEmoji(info.telop);

  let body = `<center>
${mfm.bold(mfm.color(title, themeColor))} ${emoji}
---
${info.dateLabel}の天気は「${mfm.bold(
    mfm.color(info.telop, themeColor)
  )}」みたいですよ！

`;

  if (info.tempMin || info.tempMax) {
    body += `🌡️ ${mfm.bold('気温')}
最高: ${mfm.color(info.tempMax ?? '?', 'ff4500')}℃
最低: ${mfm.color(info.tempMin ?? '?', '4169e1')}℃

`;
  }

  if (info.rain) {
    body += `☔ ${mfm.bold('降水確率')}
0-6時:  ${mfm.color(
      info.rain.T00_06,
      getRainProbabilityColor(info.rain.T00_06)
    )}
6-12時: ${mfm.color(
      info.rain.T06_12,
      getRainProbabilityColor(info.rain.T06_12)
    )}
12-18時:${mfm.color(
      info.rain.T12_18,
      getRainProbabilityColor(info.rain.T12_18)
    )}
18-24時:${mfm.color(
      info.rain.T18_24,
      getRainProbabilityColor(info.rain.T18_24)
    )}

`;
  }

  if (info.additionalMessage) {
    body += `${info.additionalMessage}\n\n`;
  }

  body += `---
</center>
`;

  if (info.greeting) {
    body += `${info.greeting}\n`;
  }

  body += CLOSING_MESSAGES[Math.floor(Math.random() * CLOSING_MESSAGES.length)];

  return body;
}
