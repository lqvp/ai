import type { SKRSContext2D } from '@napi-rs/canvas';
import {
  UNKNOWN_WMO_CODE,
  WMO_CODE_MAP,
  type WmoCodeInfo,
} from '@/modules/weather/types.js';
import { createCanvasWithBackground } from '@/utils/canvas.js';
import { ensureFont } from '@/utils/font.js';
import type { HourlyForecast, HourlyPoint } from './open-meteo.js';

export interface RenderKiatsuOptions {
  /** 表示する列数。既定 12。 */
  maxColumns?: number;
  /** タイトルに出す地点名。渡されない場合は緯度経度で代替する。 */
  locationName?: string;
  /**
   * 表示を開始する `hours` の添字。既定 0。
   *
   * 呼び出し側が「今」を先頭に切り出す代わりに、切り出さずに開始位置だけを
   * 渡せるようにしたもの。切り出すと先頭3列の ΔP3h が計算できなくなるため、
   * 過去分（`past_days`）を含む配列をそのまま渡してここで開始位置を指定する。
   */
  startIndex?: number;
}

type ForecastColumn = {
  /** 相対日付ラベル。時刻が読めない欠測列では null。 */
  dayLabel: string | null;
  /** 0-23。時刻が読めない欠測列では null。 */
  hour: number | null;
  /** `hours` 内の絶対添字。地平外などで点が無い列では null。 */
  absoluteIndex: number | null;
  /** 元の予報点。地平外などで点が足りない列では null。 */
  point: HourlyPoint | null;
  isMissing: boolean;
};

type DropStyle = {
  background: string;
  foreground: string;
};

type ParsedHourlyTime = {
  dayIndex: number;
  hour: number;
};

const DEFAULT_MAX_COLUMNS = 12;
const MS_PER_DAY = 86_400_000;
const TIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/;

/**
 * 天気の短縮ラベル。
 * WMO_CODE_MAP の description（例: 「軽い着氷性の霧雨」）は列幅に収まらないため、
 * 描画層でこの粒度まで丸める。
 */
const SHORT_WEATHER_LABELS: Record<WmoCodeInfo['serifKey'], string> = {
  sunny: '晴',
  cloudy: '曇',
  rainy: '雨',
  snowy: '雪',
  thunder: '雷',
  other: '不明',
};

function font(size: number, weight: 'normal' | 'bold' = 'normal'): string {
  return `${weight} ${size}px ${ensureFont()}`;
}

/**
 * `YYYY-MM-DDTHH:mm` を日付通し番号と時に分解する。
 * 予報時刻は Asia/Tokyo の壁時計時刻なので、実行環境の TZ に依存しない
 * Date.UTC で日付の差だけを取り出す。
 */
function parseHourlyTime(timeLocal: string): ParsedHourlyTime | null {
  const match = TIME_LOCAL_PATTERN.exec(timeLocal);
  if (!match) return null;

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);

  if (
    Number.isNaN(year) ||
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23
  ) {
    return null;
  }

  return {
    dayIndex: Math.floor(Date.UTC(year, month - 1, day) / MS_PER_DAY),
    hour,
  };
}

function formatDayLabel(dayOffset: number): string {
  switch (dayOffset) {
    case 0:
      return '今日';
    case 1:
      return '明日';
    case 2:
      return '明後日';
    default:
      return dayOffset > 2 ? `${dayOffset}日後` : '今日';
  }
}

/**
 * 値が1つも無い列は、背景ごと灰色にして欠測であることを示す。
 */
function isPointMissing(point: HourlyPoint | null): boolean {
  if (point == null) return true;

  return (
    point.pressureMsl == null &&
    point.temperatureC == null &&
    point.weatherCode == null
  );
}

function buildForecastColumns(
  hours: readonly HourlyPoint[],
  maxColumns: number,
  startIndex: number
): ForecastColumn[] {
  const startPoint = hours[startIndex] ?? null;
  const start =
    startPoint == null ? null : parseHourlyTime(startPoint.timeLocal);

  const columns: ForecastColumn[] = [];

  for (let i = 0; i < maxColumns; i++) {
    const absoluteIndex = startIndex + i;
    const point = absoluteIndex < hours.length ? hours[absoluteIndex] : null;

    if (point == null) {
      columns.push({
        dayLabel: null,
        hour: null,
        absoluteIndex: null,
        point: null,
        isMissing: true,
      });
      continue;
    }

    const parsed = parseHourlyTime(point.timeLocal);

    // 日付ラベルの基準は表示開始点。切り出して渡された場合と同じ見え方になる。
    const dayOffset =
      parsed == null || start == null ? 0 : parsed.dayIndex - start.dayIndex;

    columns.push({
      dayLabel: parsed == null ? null : formatDayLabel(dayOffset),
      hour: parsed == null ? null : parsed.hour,
      absoluteIndex,
      point,
      isMissing: parsed == null || isPointMissing(point),
    });
  }

  return columns;
}

function getWeatherDisplay(code: number): {
  symbol: string;
  label: string;
} {
  const info = WMO_CODE_MAP[code] ?? UNKNOWN_WMO_CODE;

  // 霧（45/48）は serifKey が cloudy になるため、描画では霧として区別する。
  if (code === 45 || code === 48) {
    return { symbol: info.emoji, label: '霧' };
  }

  return {
    symbol: info.emoji,
    label: SHORT_WEATHER_LABELS[info.serifKey] ?? '不明',
  };
}

function getPressureTrend(current: number, previous: number | null): string {
  if (previous == null) return '';

  const diff = current - previous;
  if (diff >= 0.3) return '↑';
  if (diff <= -0.3) return '↓';
  return '→';
}

/**
 * 3時間の気圧低下は気象病の目安になるため、低下量で色を3段階に分ける。
 * 数値そのものを表示するのでバッジに「警戒」などの語は入れない。
 */
function getDropStyle(deltaHpa: number | null): DropStyle {
  if (deltaHpa == null) {
    return { background: '#edf2f7', foreground: '#4a5568' };
  }

  if (deltaHpa <= -2) {
    return { background: '#ffc4c4', foreground: '#8a1f1f' };
  }

  if (deltaHpa <= -1) {
    return { background: '#ffe9b8', foreground: '#7f5900' };
  }

  return { background: '#d8f5d4', foreground: '#245d27' };
}

function formatSignedDecimal(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 0) return '0.0';

  const text = rounded.toFixed(1);
  return rounded > 0 ? `+${text}` : text;
}

/**
 * ΔP3h = 3時間前との海面気圧の差。
 *
 * 列の添字ではなく `hours` の絶対添字で引く。表示開始点より前の点も配列に
 * 残っている前提なので、切り出された配列では先頭3列が欠測になる。
 */
function getPressureDelta3h(
  hours: readonly HourlyPoint[],
  absoluteIndex: number | null
): number | null {
  if (absoluteIndex == null) return null;

  const previousIndex = absoluteIndex - 3;
  if (previousIndex < 0 || absoluteIndex >= hours.length) return null;

  const current = hours[absoluteIndex].pressureMsl;
  const previous = hours[previousIndex].pressureMsl;

  if (current == null || previous == null) return null;

  return current - previous;
}

/**
 * 設定値の丸め。範囲外は例外にせず先頭に戻す（描画は止めない）。
 */
function normalizeStartIndex(
  startIndex: number | undefined,
  length: number
): number {
  if (startIndex == null || !Number.isInteger(startIndex)) return 0;
  if (startIndex < 0 || startIndex >= length) return 0;
  return startIndex;
}

function formatCoordinate(
  value: number,
  positive: string,
  negative: string
): string {
  const hemisphere = value >= 0 ? positive : negative;
  return `${Math.abs(value).toFixed(2)}°${hemisphere}`;
}

/**
 * 地点名はもう API から受け取らないので、名前が無ければ緯度経度を出す。
 * どの地点の予報かを利用者が確認できないと、誤配信に気づけないため。
 * 標高は出さない（海面更正気圧は標高に依存しない）。
 */
function formatLocationLabel(
  forecast: HourlyForecast,
  locationName?: string
): string {
  const name = locationName?.trim();
  if (name) return `地点: ${name}`;

  const latitude = formatCoordinate(forecast.latitude, 'N', 'S');
  const longitude = formatCoordinate(forecast.longitude, 'E', 'W');
  return `地点: ${latitude} ${longitude}`;
}

function formatColumnTime(column: ForecastColumn): string | null {
  if (column.dayLabel == null || column.hour == null) return null;

  return `${column.dayLabel}${column.hour}時`;
}

/**
 * 表示範囲は「時刻が分かっている列」の端から端で出す。
 * 地平外の埋め草まで含めると `表示範囲: 今日20時 - —` になって読めない。
 */
function formatRangeText(columns: readonly ForecastColumn[]): string {
  const labels = columns
    .map((column) => formatColumnTime(column))
    .filter((label): label is string => label != null);

  if (labels.length === 0) return '—';

  return `${labels[0]} - ${labels[labels.length - 1]}`;
}

function drawCenteredText(
  ctx: SKRSContext2D,
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

export function renderKiatsuImage(
  forecast: HourlyForecast,
  options?: RenderKiatsuOptions
): Buffer {
  ensureFont();

  const hours = forecast.hours ?? [];
  const requestedColumns = options?.maxColumns ?? DEFAULT_MAX_COLUMNS;
  const maxColumns =
    Number.isFinite(requestedColumns) && requestedColumns >= 1
      ? Math.floor(requestedColumns)
      : DEFAULT_MAX_COLUMNS;

  const startIndex = normalizeStartIndex(options?.startIndex, hours.length);
  const columns = buildForecastColumns(hours, maxColumns, startIndex);

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
    { key: 'pressure', label: '海面気圧(hPa)', height: 68 },
    { key: 'drop', label: '3時間変化', height: 74 },
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
  ctx.fillText('気圧予報', contentX, titleY + 24);

  ctx.fillStyle = '#4a6175';
  ctx.font = font(18);
  ctx.fillText(
    formatLocationLabel(forecast, options?.locationName),
    contentX,
    titleY + 62
  );

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
          if (column.isMissing || column.dayLabel == null) {
            drawCenteredText(
              ctx,
              '—',
              x,
              rowY,
              colWidth,
              rowHeight,
              font(22, 'bold'),
              '#7c8796'
            );
            break;
          }

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
          const weatherCode = column.point?.weatherCode ?? null;

          // 欠測は絵文字とラベルの2行にすると「—」が2つ並んで読みにくい
          if (weatherCode == null) {
            drawCenteredText(
              ctx,
              '—',
              x,
              rowY,
              colWidth,
              rowHeight,
              font(26, 'bold'),
              '#7c8796'
            );
            break;
          }

          const weather = getWeatherDisplay(weatherCode);
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
          const temperature = column.point?.temperatureC ?? null;
          const value =
            temperature == null ? '—' : `${Math.round(temperature)}°C`;

          drawCenteredText(
            ctx,
            value,
            x,
            rowY,
            colWidth,
            rowHeight,
            font(20, 'bold'),
            temperature == null ? '#7c8796' : '#173a55'
          );
          break;
        }

        case 'pressure': {
          const pressure = column.point?.pressureMsl ?? null;
          const previousPressure =
            columnIndex > 0
              ? (columns[columnIndex - 1].point?.pressureMsl ?? null)
              : null;
          const trend =
            pressure == null
              ? ''
              : getPressureTrend(pressure, previousPressure);
          const value =
            pressure == null
              ? '—'
              : `${pressure.toFixed(1)}${trend ? ` ${trend}` : ''}`;

          drawCenteredText(
            ctx,
            value,
            x,
            rowY,
            colWidth,
            rowHeight,
            font(19, 'bold'),
            pressure == null ? '#7c8796' : '#0f3554'
          );
          break;
        }

        case 'drop': {
          const delta = getPressureDelta3h(hours, column.absoluteIndex);
          const dropStyle = getDropStyle(delta);
          const badgeX = x + 9;
          const badgeY = rowY + 12;
          const badgeWidth = colWidth - 18;
          const badgeHeight = rowHeight - 24;

          ctx.fillStyle = dropStyle.background;
          ctx.fillRect(badgeX, badgeY, badgeWidth, badgeHeight);
          ctx.strokeStyle = '#cfdae6';
          ctx.lineWidth = 1;
          ctx.strokeRect(badgeX, badgeY, badgeWidth, badgeHeight);

          drawCenteredText(
            ctx,
            delta == null ? '—' : formatSignedDecimal(delta),
            badgeX,
            badgeY,
            badgeWidth,
            badgeHeight,
            font(18, 'bold'),
            dropStyle.foreground
          );
          break;
        }

        default:
          break;
      }
    }

    rowY += rowHeight;
  }

  const rangeText = formatRangeText(columns);

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#4e6477';
  ctx.font = font(16);
  ctx.fillText(`表示範囲: ${rangeText}`, contentX, rowY + footerAreaHeight / 2);

  // CC-BY 4.0 の帰属表示はライセンス上の義務なので消さない。
  ctx.textAlign = 'right';
  ctx.fillText(
    'source: Open-Meteo (JMA MSM) / CC-BY 4.0',
    panelX + panelWidth - panelPadding,
    rowY + footerAreaHeight / 2
  );

  return canvas.toBuffer('image/png');
}
