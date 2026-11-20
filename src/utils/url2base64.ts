import got from 'got';
import log from '@/utils/log.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * 軽量プライベートアドレスガード。
 *
 * localhost / 127.0.0.1 / ::1 / 0.0.0.0 とリンクローカル (169.254.x.x) のみを
 * 拒否する。RFC1918 (192.168/10、172.16-31、10.x) は LAN 内 Misskey
 * インスタンスの運用を壊さないよう、今回は対象外とする。
 */
function isBlockedLocalAddress(hostname: string): boolean {
  // IPv6 の場合 hostname は "[::1]" のように括弧付きで返るため取り除く
  const normalized = hostname.replace(/^\[|\]$/g, '');
  if (
    normalized === 'localhost' ||
    normalized === '127.0.0.1' ||
    normalized === '::1' ||
    normalized === '0.0.0.0'
  ) {
    return true;
  }
  // リンクローカル 169.254.0.0/16
  if (normalized.startsWith('169.254.')) {
    return true;
  }
  return false;
}

export function assertNotLocalAddress(url: string): void {
  const parsed = new URL(url);
  if (isBlockedLocalAddress(parsed.hostname)) {
    throw new Error(
      `Refusing to fetch from a local address: ${parsed.hostname}`
    );
  }
}

/**
 * URL から取得した内容を base64 文字列にする。
 *
 * got 15 の `.buffer()` は `Uint8Array` を返すため、`toString('base64')` を
 * 直接呼ぶと `"104,101,..."` のようなカンマ区切り文字列になる。
 * 必ず `Buffer.from()` を経由すること。
 */
export default async function urlToBase64(
  url: string,
  options?: { allowLocalAddress?: boolean }
): Promise<string> {
  if (!(options?.allowLocalAddress ?? false)) {
    assertNotLocalAddress(url);
  }
  try {
    const bytes = await got(url, {
      timeout: { request: DEFAULT_TIMEOUT_MS },
      retry: { limit: 1 },
    }).buffer();

    if (bytes.byteLength > MAX_BYTES) {
      throw new Error(
        `Fetched content exceeds size limit: ${bytes.byteLength} bytes (max ${MAX_BYTES} bytes)`
      );
    }

    return Buffer.from(bytes).toString('base64');
  } catch (err: unknown) {
    log('Error in url2base64');
    if (err instanceof Error) {
      log(`${err.name}\n${err.message}\n${err.stack}`);
    }
    throw err;
  }
}
