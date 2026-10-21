import { nowHour } from '@/services/clock.js';
import { createCanvasWithBackground } from '@/utils/canvas.js';
import { ensureFont } from '@/utils/font.js';

export interface WeatherItem {
  time: string;
  weather: string;
  temp: string;
  pressure: string;
  pressure_level: string;
}

export interface WeatherData {
  place_name: string;
  place_id: string;
  prefectures_id: string;
  dateTime: string;
  yesterday?: WeatherItem[];
  today: WeatherItem[];
  tomorrow?: WeatherItem[];
  dayaftertomorrow?: WeatherItem[];
  tommorow?: WeatherItem[];
}

type ForecastColumn = {
  dayLabel: string;
  hour: number;
  item: WeatherItem;
  isMissing: boolean;
};

type LevelStyle = {
  label: string;
  background: string;
  foreground: string;
};

const DISPLAY_HOURS = 12;
function font(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight} ${size}px ${ensureFont()}`;
}

function normalizeHour(raw: string): number | null {
  const hour = Number.parseInt(raw, 10);
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return null;
  return hour;
}

function parseApiHour(dateTime: string): number {
  const match = dateTime.match(/(\d{1,2})$/);
  if (!match) return nowHour();

  const hour = Number.parseInt(match[1], 10);
  if (Number.isNaN(hour) || hour < 0 || hour > 23) return nowHour();

  return hour;
}

function findItemByHour(
  items: WeatherItem[] | undefined,
  hour: number
): WeatherItem | null {
  if (!items || !Array.isArray(items)) return null;

  return (
    items.find((item) => {
      const itemHour = normalizeHour(item.time);
      return itemHour === hour;
    }) ?? null
  );
}

function createMissingItem(hour: number): WeatherItem {
  return {
    time: hour.toString(),
    weather: '--',
    temp: '--',
    pressure: '--',
    pressure_level: '-1',
  };
}

function buildForecastColumns(
  data: WeatherData,
  hourCount: number
): ForecastColumn[] {
  const today = data.today ?? [];
  const tomorrow = data.tomorrow ?? data.tommorow ?? [];
  const dayAfterTomorrow = data.dayaftertomorrow ?? [];

  const daySources = [
    { label: '今日', items: today },
    { label: '明日', items: tomorrow },
    { label: '明後日', items: dayAfterTomorrow },
  ];

  const startHour = parseApiHour(data.dateTime);
  const columns: ForecastColumn[] = [];

  for (let i = 0; i < hourCount; i++) {
    const absoluteHour = startHour + i;
    const dayOffset = Math.floor(absoluteHour / 24);
    const source = daySources[dayOffset];

    if (!source) break;

    const hour = absoluteHour % 24;
    const item = findItemByHour(source.items, hour);

    columns.push({
      dayLabel: source.label,
      hour,
      item: item ?? createMissingItem(hour),
      isMissing: item == null,
    });
  }

  if (columns.length === 0) {
    const fallbackHour = nowHour();
    columns.push({
      dayLabel: '今日',
      hour: fallbackHour,
      item: createMissingItem(fallbackHour),
      isMissing: true,
    });
  }

  return columns;
}

function getWeatherDisplay(code: string): { symbol: string; label: string } {
  if (code.startsWith('1')) return { symbol: '☀', label: '晴' };
  if (code.startsWith('2')) return { symbol: '☁', label: '曇' };
  if (code.startsWith('3')) return { symbol: '☂', label: '雨' };
  if (code.startsWith('4')) return { symbol: '❄', label: '雪' };
  return { symbol: '・', label: '不明' };
}

function getPressureTrend(
  currentPressure: string,
  previousPressure: string | null
): string {
  const current = Number.parseFloat(currentPressure);
  const previous =
    previousPressure == null ? Number.NaN : Number.parseFloat(previousPressure);

  if (Number.isNaN(current) || Number.isNaN(previous)) return '';

  const diff = current - previous;
  if (diff >= 0.3) return '上';
  if (diff <= -0.3) return '下';
  return '横';
}

function getLevelStyle(level: string): LevelStyle {
  if (level === '0' || level === '1') {
    return {
      label: '通常',
      background: '#d8f5d4',
      foreground: '#245d27',
    };
  }

  if (level === '2') {
    return {
      label: '注意',
      background: '#ffe9b8',
      foreground: '#7f5900',
    };
  }

  if (level === '3') {
    return {
      label: '警戒',
      background: '#ffd2a8',
      foreground: '#8b3f00',
    };
  }

  if (level === '4') {
    return {
      label: '要警戒',
      background: '#ffc4c4',
      foreground: '#8a1f1f',
    };
  }

  return {
    label: '-',
    background: '#edf2f7',
    foreground: '#4a5568',
  };
}

function drawCenteredText(
  ctx: any,
  text: string,
  x: number,
  y: number,
  width: number,
  height: number,
  font: string,
  color: string
) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = font;
  ctx.fillStyle = color;
  ctx.fillText(text, x + width / 2, y + height / 2);
}

export function renderKiatsuImage(data: WeatherData): Buffer {
  ensureFont();

  const columns = buildForecastColumns(data, DISPLAY_HOURS);

  const padding = 32;
  const panelPadding = 18;
  const titleAreaHeight = 88;
  const footerAreaHeight = 44;
  const leftLabelWidth = 132;
  const colWidth = 92;

  const rows = [
    { key: 'time', label: '時間', height: 58 },
    { key: 'weather', label: '天気', height: 76 },
    { key: 'temp', label: '気温', height: 60 },
    { key: 'pressure', label: '気圧(hPa)', height: 68 },
    { key: 'level', label: '気圧警戒', height: 74 },
  ] as const;

  const tableHeight = rows.reduce((sum, row) => sum + row.height, 0);
  const width =
    padding * 2 + panelPadding * 2 + leftLabelWidth + columns.length * colWidth;
  const height =
    padding * 2 +
    panelPadding * 2 +
    titleAreaHeight +
    tableHeight +
    footerAreaHeight;

  const { canvas, ctx } = createCanvasWithBackground(width, height, '#f3f7fb');

  const panelX = padding;
  const panelY = padding;
  const panelWidth = width - padding * 2;
  const panelHeight = height - padding * 2;

  ctx.fillStyle = '#ffffff';
  ctx.fillRect(panelX, panelY, panelWidth, panelHeight);
  ctx.strokeStyle = '#d4dee9';
  ctx.lineWidth = 2;
  ctx.strokeRect(panelX, panelY, panelWidth, panelHeight);

  const contentX = panelX + panelPadding;
  const titleY = panelY + panelPadding;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#12324a';
  ctx.font = font(30, 'bold');
  ctx.fillText(`${data.place_name}の気圧予報`, contentX, titleY + 24);

  ctx.fillStyle = '#4a6175';
  ctx.font = font(18);
  ctx.fillText(`API更新: ${data.dateTime}`, contentX, titleY + 62);

  const tableX = contentX;
  let rowY = titleY + titleAreaHeight;

  for (const row of rows) {
    const rowHeight = row.height;

    ctx.fillStyle = '#f8fbff';
    ctx.fillRect(tableX, rowY, leftLabelWidth, rowHeight);
    ctx.strokeStyle = '#d7e1ec';
    ctx.lineWidth = 1;
    ctx.strokeRect(tableX, rowY, leftLabelWidth, rowHeight);

    drawCenteredText(
      ctx,
      row.label,
      tableX,
      rowY,
      leftLabelWidth,
      rowHeight,
      font(18, 'bold'),
      '#27445c'
    );

    for (let columnIndex = 0; columnIndex < columns.length; columnIndex++) {
      const column = columns[columnIndex];
      const x = tableX + leftLabelWidth + colWidth * columnIndex;

      const baseColor =
        columnIndex === 0
          ? '#e7f2ff'
          : columnIndex % 2 === 0
            ? '#ffffff'
            : '#f7fbff';
      const missingColor = '#f2f4f7';

      ctx.fillStyle = column.isMissing ? missingColor : baseColor;
      ctx.fillRect(x, rowY, colWidth, rowHeight);
      ctx.strokeStyle = '#d7e1ec';
      ctx.lineWidth = 1;
      ctx.strokeRect(x, rowY, colWidth, rowHeight);

      switch (row.key) {
        case 'time': {
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';

          ctx.fillStyle = '#5b7085';
          ctx.font = font(15);
          ctx.fillText(
            column.dayLabel,
            x + colWidth / 2,
            rowY + rowHeight * 0.3
          );

          ctx.fillStyle = '#163550';
          ctx.font = font(24, 'bold');
          ctx.fillText(
            `${column.hour}`,
            x + colWidth / 2,
            rowY + rowHeight * 0.68
          );
          break;
        }

        case 'weather': {
          const weather = getWeatherDisplay(column.item.weather);
          const tone = column.isMissing ? '#7c8796' : '#223b53';

          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = tone;
          ctx.font = font(26, 'bold');
          ctx.fillText(
            weather.symbol,
            x + colWidth / 2,
            rowY + rowHeight * 0.4
          );

          ctx.font = font(16);
          ctx.fillText(
            weather.label,
            x + colWidth / 2,
            rowY + rowHeight * 0.77
          );
          break;
        }

        case 'temp': {
          const value = column.isMissing ? '-' : `${column.item.temp}°C`;
          drawCenteredText(
            ctx,
            value,
            x,
            rowY,
            colWidth,
            rowHeight,
            font(20, 'bold'),
            column.isMissing ? '#7c8796' : '#173a55'
          );
          break;
        }

        case 'pressure': {
          const previousPressure =
            columnIndex > 0 && !columns[columnIndex - 1].isMissing
              ? columns[columnIndex - 1].item.pressure
              : null;
          const trend = getPressureTrend(
            column.item.pressure,
            previousPressure
          );
          const value = column.isMissing
            ? '-'
            : `${column.item.pressure}${trend ? ` ${trend}` : ''}`;

          drawCenteredText(
            ctx,
            value,
            x,
            rowY,
            colWidth,
            rowHeight,
            font(19, 'bold'),
            column.isMissing ? '#7c8796' : '#0f3554'
          );
          break;
        }

        case 'level': {
          const levelStyle = getLevelStyle(column.item.pressure_level);
          const badgeX = x + 9;
          const badgeY = rowY + 12;
          const badgeWidth = colWidth - 18;
          const badgeHeight = rowHeight - 24;

          ctx.fillStyle = levelStyle.background;
          ctx.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);
          ctx.strokeStyle = '#cfdae6';
          ctx.lineWidth = 1;
          ctx.strokeRect(badgeX, badgeY, badgeWidth, badgeHeight);

          drawCenteredText(
            ctx,
            levelStyle.label,
            badgeX,
            badgeY,
            badgeWidth,
            badgeHeight,
            font(16, 'bold'),
            levelStyle.foreground
          );
          break;
        }

        default:
          break;
      }
    }

    rowY += rowHeight;
  }

  const first = columns[0];
  const last = columns[columns.length - 1];
  const rangeText = `${first.dayLabel}${first.hour}時 - ${last.dayLabel}${last.hour}時`;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#4e6477';
  ctx.font = font(16);
  ctx.fillText(`表示範囲: ${rangeText}`, contentX, rowY + footerAreaHeight / 2);

  ctx.textAlign = 'right';
  ctx.fillText(
    'source: zutool.jp',
    panelX + panelWidth - panelPadding,
    rowY + footerAreaHeight / 2
  );

  return canvas.toBuffer('image/png');
}
