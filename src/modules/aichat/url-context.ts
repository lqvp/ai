import urlToJson from '@/utils/url2json.js';
import type { AiChat, TimelineContext, UrlPreview } from './types.js';

export type UrlPreviewResult = {
  youtubeURLs: string[];
  hasYoutubeUrl: boolean;
  fallbackUrlInfo: string;
};

export const URL_PATTERN = "(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)";

/** YouTube として扱うホスト名の集合。 */
const YOUTUBE_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
  'youtu.be',
  'www.youtu.be',
  'www.youtube-nocookie.com',
]);

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase();
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
 * YouTube の URL かどうか（ホスト名の厳密一致）。
 */
export function isYoutubeUrl(url: string): boolean {
  const hostname = hostnameOf(url);
  return hostname != null && YOUTUBE_HOSTS.has(hostname);
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

/**
 * YouTube の URL を `https://www.youtube.com/watch?v=ID` に正規化する。
 * 解析できない場合は元の URL をそのまま返す。
 */
export function normalizeYoutubeUrl(
  url: string,
  log: (message: string) => void = () => {}
): string {
  try {
    const urlObj = new URL(url);
    let videoId = '';

    if (urlObj.hostname.includes('youtu.be')) {
      videoId = urlObj.pathname.split('/')[1];
    } else if (urlObj.hostname.includes('youtube.com')) {
      videoId = urlObj.searchParams.get('v') || '';
    }

    if (videoId) {
      return `https://www.youtube.com/watch?v=${videoId}`;
    }
  } catch (error) {
    log(`YouTube URL解析エラー: ${error}`);
  }

  return url;
}

/**
 * 文字列に含まれる URL を列挙する。
 */
export function extractUrls(text: string): string[] {
  return [...text.matchAll(new RegExp(URL_PATTERN, 'g'))].map(
    (match) => match[0]
  );
}

/**
 * 質問文と会話履歴から YouTube URL とフォールバック用のプレビュー文を集める。
 * Gemini / OpenAI 両方のプロンプト構築で共有する。
 */
export async function collectUrlInfo(
  aiChat: AiChat,
  log: (message: string) => void = () => {}
): Promise<UrlPreviewResult> {
  const youtubeURLs: string[] = [];
  let hasYoutubeUrl = false;
  let fallbackUrlInfo = '';

  if (aiChat.question !== undefined) {
    for (const url of extractUrls(aiChat.question)) {
      log('URL:' + url);

      if (isYoutubeUrl(url)) {
        log('YouTube URL detected: ' + url);
        const normalizedUrl = normalizeYoutubeUrl(url, log);
        log('Normalized YouTube URL: ' + normalizedUrl);
        youtubeURLs.push(normalizedUrl);
        hasYoutubeUrl = true;
        continue;
      }

      let result: unknown = null;
      try {
        if (isPrivateUrl(url)) {
          log('Skip private URL: ' + url);
          continue;
        }
        result = await urlToJson(url);
      } catch {
        fallbackUrlInfo +=
          '補足として提供されたURLは無効でした:URL=>' + url + '\n';
        log('Skip url becase error in urlToJson');
        continue;
      }
      const urlpreview: UrlPreview = result as UrlPreview;
      if (urlpreview.title) {
        fallbackUrlInfo +=
          '補足として提供されたURLの情報は次の通り:URL=>' +
          urlpreview.url +
          'サイト名(' +
          urlpreview.sitename +
          ')、';
        if (!urlpreview.sensitive) {
          fallbackUrlInfo +=
            'タイトル(' +
            urlpreview.title +
            ')、' +
            '説明(' +
            urlpreview.description +
            ')、' +
            '質問にあるURLとサイト名・タイトル・説明を組み合わせ、回答の参考にすること。\n';
          log('urlpreview.sitename:' + urlpreview.sitename);
          log('urlpreview.title:' + urlpreview.title);
          log('urlpreview.description:' + urlpreview.description);
        } else {
          fallbackUrlInfo +=
            'これはセンシティブなURLの可能性があるため、質問にあるURLとサイト名のみで、回答の参考にすること(使わなくても良い)。\n';
        }
      } else {
        log('urlpreview.title is nothing');
      }
    }
  }

  // 保存された YouTube の URL を会話履歴から取得
  if (aiChat.history && aiChat.history.length > 0) {
    const firstUserMessage = aiChat.history.find(
      (entry) => entry.role === 'user'
    );
    if (firstUserMessage) {
      for (const url of extractUrls(firstUserMessage.content)) {
        if (isYoutubeUrl(url)) {
          const normalizedUrl = normalizeYoutubeUrl(url, log);
          if (!youtubeURLs.includes(normalizedUrl)) {
            log('Found YouTube URL in history: ' + normalizedUrl);
            youtubeURLs.push(normalizedUrl);
            hasYoutubeUrl = true;
          }
        }
      }
    }
  }

  return { youtubeURLs, hasYoutubeUrl, fallbackUrlInfo };
}

/**
 * 投稿文脈（前後のノート）をプロンプト用の文字列にする。
 */
export function formatTimelineContext(
  context?: TimelineContext | null
): string {
  if (!context) return '';

  let text = '\n\n【ユーザー投稿履歴文脈情報】\n';
  text +=
    'これらの情報は、同じユーザーが最近投稿した内容で、メインの投稿への返信を生成する際の話題の流れや雰囲気を把握する参考程度に留めてください。メインの投稿に対する返信であることを忘れないでください。\n';

  const before = context.before ?? [];
  before.forEach((note, index) => {
    text += `以前の投稿${before.length > 1 ? `(${index + 1})` : ''}: ${note.text}\n`;
  });

  const after = context.after ?? [];
  after.forEach((note, index) => {
    text += `その後の投稿${after.length > 1 ? `(${index + 1})` : ''}: ${note.text}\n`;
  });

  return text;
}
