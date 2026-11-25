import type { SKRSContext2D } from '@napi-rs/canvas';
import {
  UNKNOWN_WMO_CODE,
  WMO_CODE_MAP,
  type WmoCodeInfo,
} from '@/modules/weather/types.js';
import { createCanvasWithBackground } from '@/utils/canvas.js';
import { ensureFont } from '@/utils/font.js';
import type { HourlyForecast, HourlyPoint } from './open-meteo.js';
import { COMPARISON_EPSILON, formatDeltaHpa } from './pressure-trend.js';

export interface RenderKiatsuOptions {
  /** 表示する列数。既定 12。 */
  maxColumns?: number;
  /** タイトルに出す地点名。未指定・空欄時は座標を出さず「設定地点」とする。 */
  locationName?: string;
  /** 描画時点のローカル時刻（`YYYY-MM-DDTHH:00`）。相対日付の基準に使う */
  nowLocal?: string;
  /**
   * 表示を開始する `hours` の添字。既定 0。
   *
   * 呼び出し側が「今」を先頭に切り出す代わりに、切り出さずに開始位置だけを
   * 渡せるようにしたもの。切り出すと先頭3列の ΔP3h が計算できなくなるため、
   * 過去分（`past_days`）を含む配列をそのまま渡してここで開始位置を指定する。
   */
  startIndex?: number;
  /**
   * 3時間変化の色分けに使う閾値（負値）。既定 -2。
   *
   * 投稿判定（`pressure-trend` の `thresholdHpa`）と同じ設定を渡さないと、
   * 画像では赤なのに投稿されない（逆も）という食い違いが起きるため、
   * 警報色の境界はハードコードせず設定に追随させる。注意色はその半分を目安にする。
   * 不正値は例外にせず既定へ丸める（描画は止めない）。
   */
  thresholdHpa?: number;
  /**
   * 画像の取得時刻（`YYYY-MM-DDTHH:mm`）。
   *
   * 画像だけを見て「いつのデータか」を判断できるようにするためのもの。
   * 取得に失敗して古い予報を出したとき、これが無いと最新のデータに見えてしまう。
   * 未指定なら何も描かず、レイアウトも変えない（既存の見た目を壊さない）。
   */
  fetchedAtLocal?: string;
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

type WeatherDisplay = {
  /** `./font.ttf` に収録されている BMP 記号。雷のみベクター描画を使う。 */
  symbol: string | 'thunder-vector';
  label: string;
};

const DEFAULT_MAX_COLUMNS = 12;
const DEFAULT_THRESHOLD_HPA = -2;
const MS_PER_DAY = 86_400_000;
const TIME_LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})/;
const FETCHED_AT_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/;

/**
 * 天気の短縮ラベルと記号。
 *
 * `WMO_CODE_MAP` の `emoji`（`🌤️` `🌧️` `🌫️` `☔` 等のカラー絵文字）をそのまま
 * `@napi-rs/canvas` に渡すと、同梱の `./font.ttf` や Docker 環境（絵文字フォント無し）
 * では未収録グリフの豆腐（`□`）になる。ここでは `./font.ttf` 収録確認済みの
 * BMP 文字記号（`☀` `☁` `☂` `☃` `≡` `・`）と、フォント非依存のベクター描画（雷）に限定する。
 */
const WEATHER_DISPLAY_BY_KEY: Record<WmoCodeInfo['serifKey'], WeatherDisplay> =
  {
    sunny: { symbol: '☀', label: '晴' },
    cloudy: { symbol: '☁', label: '曇' },
    rainy: { symbol: '☂', label: '雨' },
    snowy: { symbol: '☃', label: '雪' },
    thunder: { symbol: 'thunder-vector', label: '雷' },
    other: { symbol: '・', label: '不明' },
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

/**
 * 日付ラベル。
 *
 * 基準は「描画時点の日付（`nowLocal`）」。予報の先頭を基準にすると、
 * 前日の予報を描いたときに前日を「今日」と表示してしまう。
 * `nowLocal` が渡されない呼び出しでは表示開始点の日付を基準にする。
 */
function formatDayLabel(dayOffset: number): string {
  switch (dayOffset) {
    case 0:
      return '今日';
    case 1:
      return '明日';
    case 2:
      return '明後日';
    case -1:
      return '昨日';
    default:
      return dayOffset > 2 ? `${dayOffset}日後` : `${-dayOffset}日前`;
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
  startIndex: number,
  base: ParsedHourlyTime | null
): ForecastColumn[] {
  const startPoint = hours[startIndex] ?? null;
  const start =
    base ?? (startPoint == null ? null : parseHourlyTime(startPoint.timeLocal));

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

    // 相対日付の基準は描画時点（base）。未指定のときだけ表示開始点を使う。
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

function getWeatherDisplay(code: number): WeatherDisplay {
  const info = WMO_CODE_MAP[code] ?? UNKNOWN_WMO_CODE;

  // 霧（45/48）は serifKey が cloudy になるため、描画では三本線記号で霧として区別する。
  if (code === 45 || code === 48) {
    return { symbol: '≡', label: '霧' };
  }

  return WEATHER_DISPLAY_BY_KEY[info.serifKey] ?? WEATHER_DISPLAY_BY_KEY.other;
}

/**
 * `⚡`（U+26A1）は同梱フォントにグリフが無いため、Canvas パスで稲妻を描く。
 */
function drawThunderBolt(
  ctx: SKRSContext2D,
  centerX: number,
  centerY: number,
  color: string
): void {
  ctx.save();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(centerX + 2, centerY - 12);
  ctx.lineTo(centerX - 8, centerY + 1);
  ctx.lineTo(centerX - 1, centerY + 1);
  ctx.lineTo(centerX - 4, centerY + 12);
  ctx.lineTo(centerX + 8, centerY - 2);
  ctx.lineTo(centerX + 1, centerY - 2);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function getPressureTrend(current: number, previous: number | null): string {
  if (previous == null) return '';

  const diff = current - previous;
  // 0.1 hPa 刻みの引き算誤差（例: 979.7 - 980.0 = -0.2999999999999545）を吸収する
  if (diff >= 0.3 - COMPARISON_EPSILON) return '↑';
  if (diff <= -0.3 + COMPARISON_EPSILON) return '↓';
  return '→';
}

/**
 * 3時間の気圧低下は気象病の目安になるため、低下量で色を3段階に分ける。
 * 数値そのものを表示するのでバッジに「警戒」などの語は入れない。
 *
 * 警報の境界は設定の閾値（負値）に合わせる。注意の境界はその半分を目安に
 * 置き、閾値を緩めても強めても段階の幅が比例して動くようにする。
 * 判定層の `evaluateAlert` と同じ `COMPARISON_EPSILON` を使い、警報投稿や
 * 表示テキスト（`-2.0` 等）とバッジ色が食い違わないようにする。
 */
function getDropStyle(
  deltaHpa: number | null,
  thresholdHpa: number
): DropStyle {
  if (deltaHpa == null) {
    return { background: '#edf2f7', foreground: '#4a5568' };
  }

  if (deltaHpa <= thresholdHpa + COMPARISON_EPSILON) {
    return { background: '#ffc4c4', foreground: '#8a1f1f' };
  }

  if (deltaHpa <= thresholdHpa / 2 + COMPARISON_EPSILON) {
    return { background: '#ffe9b8', foreground: '#7f5900' };
  }

  return { background: '#d8f5d4', foreground: '#245d27' };
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

/**
 * 色分けの閾値の丸め。
 *
 * 投稿判定側（`pressure-trend`）は不正値を例外にするが、描画は画像を1枚
 * 出すだけの処理なので、設定ミスで投稿全体を止めるより既定で描くほうがよい。
 * 0 以上だと「下回ったら警報」が成立しない（0 は常時警報になる）ため、
 * これも既定へ落とす。unknown で受けるのは、型の無い呼び出し元から
 * 数値以外が来ても比較が静かに壊れないようにするため。
 */
function normalizeThresholdHpa(value: unknown): number {
  if (typeof value !== 'number') return DEFAULT_THRESHOLD_HPA;
  if (!Number.isFinite(value) || value >= 0) return DEFAULT_THRESHOLD_HPA;
  return value;
}

/**
 * 取得時刻文字列（`YYYY-MM-DDTHH:mm`）から `M/D HH:mm` を取り出す。
 *
 * 読めない値は null を返し、呼び出し側は何も描かない（誤った時刻を出さない）。
 */
function formatFetchedTime(fetchedAtLocal?: string): string | null {
  const value = fetchedAtLocal?.trim();
  if (!value) return null;

  const match = FETCHED_AT_PATTERN.exec(value);
  if (!match) return null;

  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  if (
    Number.isNaN(month) ||
    Number.isNaN(day) ||
    Number.isNaN(hour) ||
    Number.isNaN(minute) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59
  ) {
    return null;
  }

  return `${month}/${day} ${match[4]}:${match[5]}`;
}

/**
 * 地点ラベルを組み立てる。
 *
 * 監視地点の緯度経度は自宅付近になり得るため、名前が未設定でも座標は描かない
 * （`/info` と同じプライバシ方針）。
 */
function formatLocationLabel(locationName?: string): string {
  const name = typeof locationName === 'string' ? locationName.trim() : '';
  return name ? `地点: ${name}` : '地点: 設定地点';
}

function truncateTextToWidth(
  ctx: SKRSContext2D,
  text: string,
  maxWidth: number
): string {
  if (maxWidth <= 0) return '';
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = '…';
  const chars = [...text];
  while (chars.length > 0) {
    chars.pop();
    const candidate = `${chars.join('')}${ellipsis}`;
    if (ctx.measureText(candidate).width <= maxWidth) {
      return candidate;
    }
  }
  return ellipsis;
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
  fontSpec: string,
  color: string
) {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = fontSpec;
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
  const thresholdHpa = normalizeThresholdHpa(options?.thresholdHpa);
  // 「今日」の基準は描画時点の日付。渡されない場合は表示開始点を使う。
  const nowParsed = options?.nowLocal
    ? parseHourlyTime(options.nowLocal)
    : null;
  const columns = buildForecastColumns(
    hours,
    maxColumns,
    startIndex,
    nowParsed
  );

  const padding = 32;
  const panelPadding = 18;
  const titleAreaHeight = 88;
  const leftLabelWidth = 132;
  const colWidth = 92;

  const rows = [
    { key: 'time', label: '時間', height: 58 },
    { key: 'weather', label: '天気', height: 76 },
    { key: 'temp', label: '気温', height: 60 },
    { key: 'pressure', label: '海面気圧(hPa)', height: 68 },
    { key: 'drop', label: '3時間変化', height: 74 },
  ] as const;

  const contentWidth = leftLabelWidth + columns.length * colWidth;
  // 列数が少ない（例: maxColumns: 4）場合はフッターの左右テキストが重なるため2段に分ける
  const stackFooter = contentWidth < 620;
  const footerAreaHeight = stackFooter ? 64 : 44;

  const tableHeight = rows.reduce((sum, row) => sum + row.height, 0);
  const width = padding * 2 + panelPadding * 2 + contentWidth;
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

  const fetchedTime = formatFetchedTime(options?.fetchedAtLocal);
  const fetchedLabel = fetchedTime ? `取得: ${fetchedTime}` : null;
  let fetchedWidth = 0;
  if (fetchedLabel) {
    ctx.font = font(16);
    fetchedWidth = ctx.measureText(fetchedLabel).width + 16;
  }

  ctx.fillStyle = '#4a6175';
  ctx.font = font(18);
  const rawLocationLabel = formatLocationLabel(options?.locationName);
  const locationLabel = truncateTextToWidth(
    ctx,
    rawLocationLabel,
    Math.max(80, contentWidth - fetchedWidth)
  );
  ctx.fillText(locationLabel, contentX, titleY + 62);

  if (fetchedLabel) {
    const locationWidth = ctx.measureText(locationLabel).width;
    ctx.font = font(16);
    ctx.fillStyle = '#5b7085';
    ctx.fillText(fetchedLabel, contentX + locationWidth + 16, titleY + 62);
  }

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

          // 欠測は記号とラベルの2行にすると「—」が2つ並んで読みにくい
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

          if (weather.symbol === 'thunder-vector') {
            drawThunderBolt(
              ctx,
              x + colWidth / 2,
              rowY + rowHeight * 0.38,
              tone
            );
          } else {
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillStyle = tone;
            ctx.font = font(26, 'bold');
            ctx.fillText(
              weather.symbol,
              x + colWidth / 2,
              rowY + rowHeight * 0.4
            );
          }

          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = tone;
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
          const dropStyle = getDropStyle(delta, thresholdHpa);
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
            delta == null ? '—' : formatDeltaHpa(delta),
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

  const rangeText = `表示範囲: ${formatRangeText(columns)}`;
  const sourceText = 'source: Open-Meteo (JMA MSM) / CC-BY 4.0';

  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#5b7085';
  ctx.font = font(15);

  if (stackFooter) {
    ctx.textAlign = 'left';
    ctx.fillText(rangeText, contentX, rowY + 20);
    ctx.fillText(sourceText, contentX, rowY + 44);
  } else {
    ctx.textAlign = 'left';
    ctx.fillText(rangeText, contentX, rowY + footerAreaHeight / 2);
    ctx.textAlign = 'right';
    ctx.fillText(
      sourceText,
      panelX + panelWidth - panelPadding,
      rowY + footerAreaHeight / 2
    );
  }

  return canvas.toBuffer('image/png');
}
