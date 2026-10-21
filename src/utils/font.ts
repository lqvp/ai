import { existsSync } from 'node:fs';
import { GlobalFonts } from '@napi-rs/canvas';

/**
 * 画像生成用フォントの登録を1箇所に集約する。
 *
 * 以前は chart / kiatsu がレンダリングのたびに `registerFromPath` を呼び、
 * maze はフォントを登録していなかった（日本語が豆腐になる）。
 * ここでは初回のみ登録し、以後はキャッシュしたファミリ名を返す。
 */

export const FONT_PATH = './font.ttf';
export const FONT_FAMILY = 'AiCustomFont';

let registered: boolean | null = null;

/**
 * 利用可能なフォントファミリ名を返す。
 * font.ttf が無い場合は 'sans-serif' にフォールバックする。
 */
export function ensureFont(): string {
  if (registered !== null) {
    return registered ? FONT_FAMILY : 'sans-serif';
  }

  if (!existsSync(FONT_PATH)) {
    registered = false;
    return 'sans-serif';
  }

  try {
    registered = GlobalFonts.registerFromPath(FONT_PATH, FONT_FAMILY) != null;
  } catch {
    registered = false;
  }

  return registered ? FONT_FAMILY : 'sans-serif';
}

/**
 * `font` の値が指定できる形式の CSS フォント文字列を返す。
 */
export function fontStyle(
  size: number,
  weight: 'normal' | 'bold' = 'normal'
): string {
  return `${weight} ${size}px ${ensureFont()}`;
}

/**
 * テスト用にキャッシュをリセットする。
 */
export function resetFontCache(): void {
  registered = null;
}
