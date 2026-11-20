/**
 * HTTP クライアントの薄いラッパー。
 *
 * - got 15 の API 変更（`url` を options に入れられない、`buffer()` が Uint8Array）
 *   をここに閉じ込める。
 * - タイムアウトの既定値を1箇所に集約する。
 */

import got, { type OptionsInit } from 'got';

export const DEFAULT_TIMEOUT_MS = 30_000;

type RequestOptions = Omit<OptionsInit, 'timeout' | 'retry'> & {
  timeoutMs?: number;
  retryLimit?: number;
};

/** GET 系リクエストのデフォルトリトライ回数（POST は既定でリトライしない）。 */
const DEFAULT_GET_RETRY_LIMIT = 2;

function buildOptions(
  options: RequestOptions = {},
  defaultRetryLimit = 0
): OptionsInit {
  const { timeoutMs, retryLimit, ...rest } = options;
  return {
    timeout: { request: timeoutMs ?? DEFAULT_TIMEOUT_MS },
    retry: { limit: retryLimit ?? defaultRetryLimit },
    ...rest,
  };
}

export async function getJson<T>(
  url: string,
  options?: RequestOptions
): Promise<T> {
  return got.get(url, buildOptions(options, DEFAULT_GET_RETRY_LIMIT)).json<T>();
}

export async function postJson<T>(
  url: string,
  json: unknown,
  options?: RequestOptions
): Promise<T> {
  return got
    .post(url, { ...buildOptions(options), json: json as never })
    .json<T>();
}

export async function getText(
  url: string,
  options?: RequestOptions
): Promise<string> {
  return got.get(url, buildOptions(options, DEFAULT_GET_RETRY_LIMIT)).text();
}

/**
 * バイナリ取得。got 15 の `buffer()` は Uint8Array を返すため Buffer に変換する。
 */
export async function getBuffer(
  url: string,
  options?: RequestOptions
): Promise<Buffer> {
  const bytes = await got
    .get(url, buildOptions(options, DEFAULT_GET_RETRY_LIMIT))
    .buffer();
  return Buffer.from(bytes);
}

export async function postForm<T>(
  url: string,
  form: FormData,
  options?: RequestOptions
): Promise<T> {
  return got
    .post(url, {
      ...buildOptions(options),
      body: form,
    })
    .json<T>();
}

export { got };
