/**
 * エラー処理の共通ユーティリティ。
 * got / axios / Loki など、ライブラリごとに異なるエラー形状を1箇所で吸収する。
 */

export function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(typeof value === 'string' ? value : JSON.stringify(value));
}

type HttpErrorLike = {
  response?: { statusCode?: number; statusMessage?: string };
  statusCode?: number;
  statusMessage?: string;
  code?: string;
  message?: string;
};

/**
 * HTTP ステータスコードを取り出す。
 * got は `err.response.statusCode`、古いコードや axios は `err.statusCode` を見る。
 */
export function getHttpStatus(err: unknown): number | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const e = err as HttpErrorLike;
  const status = e.response?.statusCode ?? e.statusCode;
  return typeof status === 'number' ? status : undefined;
}

export function getHttpStatusMessage(err: unknown): string | undefined {
  if (err == null || typeof err !== 'object') return undefined;
  const e = err as HttpErrorLike;
  return e.response?.statusMessage ?? e.statusMessage;
}

export function isHttpStatus(err: unknown, status: number): boolean {
  return getHttpStatus(err) === status;
}

/**
 * API エラーを1行のメッセージにする。ログとユーザー向け表示の両方で使う。
 */
export function formatApiError(err: unknown, source?: string): string {
  const status = getHttpStatus(err);
  const statusMessage = getHttpStatusMessage(err);
  const message = toError(err).message;

  if (status !== undefined) {
    const tail = statusMessage ? ` ${statusMessage}` : '';
    const prefix = source ? `${source}: ` : '';
    return `${prefix}HTTP ${status}${tail} (${message})`;
  }

  return source ? `${source}: ${message}` : message;
}

/**
 * エラーのスタックを安全に文字列化する。
 */
export function errorToString(err: unknown): string {
  const error = toError(err);
  return error.stack ?? `${error.name}: ${error.message}`;
}
