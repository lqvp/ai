import got from 'got';
import log from '@/utils/log.js';

const DEFAULT_TIMEOUT_MS = 30_000;

/**
 * URL から取得した内容を base64 文字列にする。
 *
 * got 15 の `.buffer()` は `Uint8Array` を返すため、`toString('base64')` を
 * 直接呼ぶと `"104,101,..."` のようなカンマ区切り文字列になる。
 * 必ず `Buffer.from()` を経由すること。
 */
export default async function urlToBase64(url: string): Promise<string> {
  try {
    const bytes = await got(url, {
      timeout: { request: DEFAULT_TIMEOUT_MS },
      retry: { limit: 1 },
    }).buffer();

    return Buffer.from(bytes).toString('base64');
  } catch (err: unknown) {
    log('Error in url2base64');
    if (err instanceof Error) {
      log(`${err.name}\n${err.message}\n${err.stack}`);
    }
    throw err;
  }
}
