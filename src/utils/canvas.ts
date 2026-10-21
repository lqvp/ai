import { type Canvas, createCanvas, type SKRSContext2D } from '@napi-rs/canvas';

export type CanvasWithContext = {
  canvas: Canvas;
  ctx: SKRSContext2D;
};

/**
 * 背景色で塗りつぶしたキャンバスを作る。
 * chart / kiatsu / maze で同じ手順を書いていたものをまとめた。
 */
export function createCanvasWithBackground(
  width: number,
  height: number,
  backgroundColor: string
): CanvasWithContext {
  const canvas = createCanvas(width, height);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = backgroundColor;
  ctx.beginPath();
  ctx.fillRect(0, 0, width, height);

  return { canvas, ctx };
}
