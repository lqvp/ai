function hostnameOf(url: string): string | null {
  try {
    // 末尾ドット付きFQDN (例: "metadata.google.internal.") も
    // 同一ホストとして扱えるよう、DNS的に等価な末尾ドットを除去する
    return new URL(url).hostname.toLowerCase().replace(/\.+$/, '');
  } catch {
    return null;
  }
}

/**
 * IPv4-mapped IPv6 アドレス (::ffff:a.b.c.d または ::ffff:7f00:1 形式) から
 * 埋め込み IPv4 を復元する。IPv4-mapped でない場合は null を返す。
 */
function ipv6ToIpv4(ipv6: string): string | null {
  if (!ipv6.startsWith('::ffff:')) return null;

  const tail = ipv6.slice('::ffff:'.length);
  if (tail.includes('.')) {
    // ::ffff:127.0.0.1 形式
    return tail;
  }

  // ::ffff:a00:1 のような16進形式 (下位32ビットがIPv4)
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
 * プライベートネットワーク・リンクローカルを指す URL かどうか。
 * DNS 解決は行わず、IPv4 リテラルと localhost 系のホスト名の文字列チェックのみ。
 */
export function isPrivateUrl(url: string): boolean {
  const hostname = hostnameOf(url);
  if (hostname == null) return false;

  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === 'metadata.google.internal' ||
    hostname.endsWith('.metadata.google.internal')
  ) {
    return true;
  }

  // IPv4 リテラル
  const ipv4Match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
    hostname
  );
  if (ipv4Match) {
    const octets = ipv4Match
      .slice(1)
      .map((o) => Number.parseInt(o, 10))
      .sort((a, b) => a - b);
    if (octets.some((o) => o > 255)) return false; // 不正なIPv4は対象外
    const [a, b] = ipv4Match
      .slice(1)
      .map((o) => Number.parseInt(o, 10)) as unknown as [number, number];
    return (
      a === 127 || // ループバック
      a === 10 || // プライベート
      a === 0 ||
      (a === 172 && b >= 16 && b <= 31) || // プライベート
      (a === 192 && b === 168) || // プライベート
      (a === 169 && b === 254) // リンクローカル
    );
  }

  // IPv6 リテラル
  const ipv6 = hostname.replace(/^\[|\]$/g, '');

  // IPv4-mapped IPv6 (::ffff:a.b.c.d / ::ffff:aabb:ccdd) は埋め込みIPv4として判定する。
  // Node の URL パーサーは http://[::ffff:127.0.0.1]/ を [::ffff:7f00:1] に
  // 正規化するため、IPv6 チェックの前に対処する必要がある。
  const ipv4 = ipv6ToIpv4(ipv6);
  if (ipv4) {
    return isPrivateUrl(`http://${ipv4}/`);
  }

  if (ipv6.includes(':')) {
    return (
      ipv6 === '::' ||
      ipv6 === '::1' ||
      ipv6.toLowerCase().startsWith('fe80:') || // リンクローカル
      ipv6.toLowerCase().startsWith('fc') || // unique local
      ipv6.toLowerCase().startsWith('fd')
    );
  }

  return false;
}
