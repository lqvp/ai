import got from 'got';
import log from '@/utils/log.js';

const JINA_TIMEOUT_MS = 30_000;
const JINA_SEARCH_ENDPOINT = 'https://s.jina.ai/';
const JINA_READ_ENDPOINT = 'https://r.jina.ai/';
const JINA_DEFAULT_MAX_RESULTS = 5;
const JINA_MAX_RESULTS_LIMIT = 5;
const JINA_MIN_RESULTS_LIMIT = 1;

export type JinaSearchOptions = {
  apiKey?: string;
  maxResults?: number;
};

export type JinaReadOptions = {
  apiKey?: string;
  tokenBudget?: number;
};

type JinaSearchResultItem = {
  url?: string;
  title?: string;
  content?: string;
  description?: string;
  timestamp?: string;
};

type JinaReadResponse = {
  url?: string;
  title?: string;
  content?: string;
  description?: string;
  timestamp?: string;
};

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) {
    return JINA_DEFAULT_MAX_RESULTS;
  }
  const rounded = Math.floor(value);
  if (rounded < JINA_MIN_RESULTS_LIMIT) return JINA_MIN_RESULTS_LIMIT;
  if (rounded > JINA_MAX_RESULTS_LIMIT) return JINA_MAX_RESULTS_LIMIT;
  return rounded;
}

function formatJinaError(err: unknown, source: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const httpError = err as {
      response?: { statusCode?: number; statusMessage?: string };
      message?: string;
    };
    const code = httpError.response?.statusCode;
    const statusMessage = httpError.response?.statusMessage;
    if (typeof code === 'number') {
      const tail = statusMessage ? ` ${statusMessage}` : '';
      return `Error: jina API returned status ${code}${tail}`;
    }
    if (httpError.message) {
      return `Error: ${source} failed: ${httpError.message}`;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Error: ${source} failed: ${message}`;
}

export async function jinaSearch(
  query: string,
  options: JinaSearchOptions = {}
): Promise<string> {
  if (!options.apiKey) {
    return 'Error: jina search requires an apiKey (configure [jina].apiKey).';
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return 'Error: jina search query is empty.';
  }

  const maxResults = clampMaxResults(options.maxResults);

  try {
    const data = await got(
      `${JINA_SEARCH_ENDPOINT}${encodeURIComponent(trimmed)}`,
      {
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          Accept: 'application/json',
        },
        timeout: { request: JINA_TIMEOUT_MS },
        responseType: 'json',
      }
    ).json<JinaSearchResultItem[]>();

    const items = Array.isArray(data) ? data.slice(0, maxResults) : [];
    if (items.length === 0) {
      return 'jina search returned no results.';
    }

    const blocks = items.map((item, index) => {
      const title = item.title || '(no title)';
      const url = item.url || '(no url)';
      const body = item.content || item.description || '';
      const trimmedBody =
        body.length > 2000 ? `${body.slice(0, 2000)}...` : body;
      return `[${index + 1}] ${title}\nURL: ${url}${trimmedBody ? `\n${trimmedBody}` : ''}`;
    });

    return blocks.join('\n\n');
  } catch (err: unknown) {
    log('Error in jinaSearch');
    if (err instanceof Error) {
      log(`${err.name}\n${err.message}\n${err.stack}`);
    }
    return formatJinaError(err, 'jinaSearch');
  }
}

export async function jinaRead(
  url: string,
  options: JinaReadOptions = {}
): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return 'Error: invalid URL.';
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return 'Error: only http/https URLs are supported.';
  }

  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (options.apiKey) {
    headers.Authorization = `Bearer ${options.apiKey}`;
  }
  if (options.tokenBudget !== undefined && !Number.isNaN(options.tokenBudget)) {
    headers['X-Token-Budget'] = String(options.tokenBudget);
  }

  try {
    const data = await got
      .post(JINA_READ_ENDPOINT, {
        form: { url },
        headers,
        timeout: { request: JINA_TIMEOUT_MS },
        responseType: 'json',
      })
      .json<JinaReadResponse>();

    const body =
      data.content || data.description || data.title || '(no content)';
    return body;
  } catch (err: unknown) {
    log('Error in jinaRead');
    if (err instanceof Error) {
      log(`${err.name}\n${err.message}\n${err.stack}`);
    }
    return formatJinaError(err, 'jinaRead');
  }
}
