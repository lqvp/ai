import urlToJson from '@/utils/url2json.js';
import type { AiChat, UrlPreview } from './types.js';

export type UrlPreviewResult = {
  youtubeURLs: string[];
  hasYoutubeUrl: boolean;
  fallbackUrlInfo: string;
};

export const URL_PATTERN = "(https?://[a-zA-Z0-9!?/+_~=:;.,*&@#$%'-]+)";

/**
 * YouTube の URL かどうか。
 */
export function isYoutubeUrl(url: string): boolean {
  return (
    url.includes('www.youtube.com') ||
    url.includes('m.youtube.com') ||
    url.includes('youtu.be')
  );
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
  context?: { before?: any[]; after?: any[] } | null
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
