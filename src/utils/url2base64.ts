import got from 'got';
import log from '@/utils/log.js';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BYTES = 20 * 1024 * 1024; // 20MB

/**
 * IPv4-mapped IPv6 (::ffff:127.0.0.1 / ::ffff:7f00:1) を IPv4 表現へ正規化する。
 * 参考実装は src/modules/aichat/url-context.ts の ipv6ToIpv4 だが、
 * utils から modules へ依存させないためローカルに実装している。
 */
function ipv4MappedToIpv4(host: string): string | null {
  if (!host.startsWith('::ffff:')) return null;

  const tail = host.slice('::ffff:'.length);
  if (tail.includes('.')) {
    // ::ffff:127.0.0.1 形式
    return tail;
  }

  // ::ffff:7f00:1 のような16進形式 (下位32ビットがIPv4)
  const groups = tail.split(':');
  if (groups.length !== 2) return null;

  const octets: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = Number.parseInt(group, 16);
    octets.push((value >> 8) & 0xff, value & 0xff);
  }

  return octets.join('.');
}

/**
 * 軽量プライベートアドレスガード。
 *
 * localhost / ::1 / 0.0.0.0 とリンクローカル (169.254.x.x、fe80::/10)、
 * ループバック 127.0.0.0/8 全体 (IPv4-mapped IPv6 表現含む) を拒否する。
 * RFC1918 (192.168/10、172.16-31、10.x) は LAN 内 Misskey
 * インスタンスの運用を壊さないよう、今回は対象外とする。
 */
function isBlockedLocalAddress(hostname: string): boolean {
  // IPv6 の場合 hostname は "[::1]" のように括弧付きで返るため取り除く。
  // 末尾ドット付き FQDN (例: "localhost.") も DNS 的に等価なので正規化する
  const normalized = hostname.replace(/^\[|\]$/g, '').replace(/\.+$/, '');
  if (normalized === 'localhost' || normalized === '::1') {
    return true;
  }
  // IPv4-mapped IPv6 を IPv4 に正規化して判定する
  const ipv4 = ipv4MappedToIpv4(normalized);
  const target = ipv4 ?? normalized;
  if (target === '0.0.0.0') {
    return true;
  }
  // ループバック 127.0.0.0/8 (127.0.0.1 だけでなく 127.x.x.x 全体)
  if (/^127\./.test(target)) {
    return true;
  }
  // リンクローカル 169.254.0.0/16
  if (target.startsWith('169.254.')) {
    return true;
  }
  // IPv6 リンクローカル fe80::/10 (IPv4 の 169.254 に相当)
  if (target.startsWith('fe80:')) {
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
 * ストリームで受信しながらサイズ上限を監視するため、
 * 得られる本文は `Buffer`。`toString('base64')` の前に
 * `Buffer.from()` 相当の変換は不要。
 */
export default async function urlToBase64(
  url: string,
  options?: { allowLocalAddress?: boolean }
): Promise<string> {
  const allowLocalAddress = options?.allowLocalAddress ?? false;
  if (!allowLocalAddress) {
    assertNotLocalAddress(url);
  }
  try {
    const stream = got.stream(url, {
      timeout: { request: DEFAULT_TIMEOUT_MS },
      retry: { limit: 1 },
      hooks: {
        beforeRedirect: [
          (redirectOptions) => {
            if (allowLocalAddress) return;
            if (!redirectOptions.url) {
              throw new Error('Refusing to follow redirect without URL');
            }
            const redirectHost = redirectOptions.url.hostname;
            if (isBlockedLocalAddress(redirectHost)) {
              throw new Error(
                `Refusing to follow redirect to a local address: ${redirectHost}`
              );
            }
          },
        ],
      },
    });

    // 受信中にサイズ超過したらストリームを中断する
    // (buffer() 完了後の判定だと巨大応答が一旦メモリに載るため)
    const bytes = await new Promise<Buffer>((resolve, reject) => {
      const chunks: Buffer[] = [];
      let receivedBytes = 0;
      stream.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.byteLength;
        if (receivedBytes > MAX_BYTES) {
          stream.destroy(
            new Error(
              `Fetched content exceeds size limit: ${receivedBytes} bytes (max ${MAX_BYTES} bytes)`
            )
          );
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', reject);
      stream.on('end', () => resolve(Buffer.concat(chunks)));
    });

    return bytes.toString('base64');
  } catch (err: unknown) {
    log('Error in url2base64');
    if (err instanceof Error) {
      log(`${err.name}\n${err.message}\n${err.stack}`);
    }
    throw err;
  }
}
