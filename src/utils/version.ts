/**
 * バージョン文字列の比較。
 *
 * `3.10.0` と `3.9.0` を文字列比較すると誤るため、数値セグメントごとに比較する。
 * `3.2.5-lqvp` のような接尾辞は無視する。
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const parse = (version: string): number[] =>
    version
      .replace(/^v/i, '')
      .split(/[.+-]/)
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part));

  const a = parse(candidate);
  const b = parse(current);
  const length = Math.max(a.length, b.length);

  for (let i = 0; i < length; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }

  return false;
}
