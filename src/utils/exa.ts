import got from 'got';
import log from '@/utils/log.js';

const EXA_TIMEOUT_MS = 30_000;
const EXA_SEARCH_ENDPOINT = 'https://api.exa.ai/search';
const EXA_DEFAULT_MAX_RESULTS = 5;
const EXA_MAX_RESULTS_LIMIT = 5;
const EXA_MIN_RESULTS_LIMIT = 1;

export type ExaSearchOptions = {
  apiKey?: string;
  maxResults?: number;
};

type ExaSearchResultItem = {
  url?: string;
  title?: string;
  text?: string;
  summary?: string;
  highlights?: string[];
};

type ExaSearchResponse = {
  results?: ExaSearchResultItem[];
};

function clampMaxResults(value: number | undefined): number {
  if (value === undefined || Number.isNaN(value)) {
    return EXA_DEFAULT_MAX_RESULTS;
  }
  const rounded = Math.floor(value);
  if (rounded < EXA_MIN_RESULTS_LIMIT) return EXA_MIN_RESULTS_LIMIT;
  if (rounded > EXA_MAX_RESULTS_LIMIT) return EXA_MAX_RESULTS_LIMIT;
  return rounded;
}

function formatExaError(err: unknown, source: string): string {
  if (err && typeof err === 'object' && 'response' in err) {
    const httpError = err as {
      response?: { statusCode?: number; statusMessage?: string };
      message?: string;
    };
    const code = httpError.response?.statusCode;
    const statusMessage = httpError.response?.statusMessage;
    if (typeof code === 'number') {
      const tail = statusMessage ? ` ${statusMessage}` : '';
      return `Error: exa API returned status ${code}${tail}`;
    }
    if (httpError.message) {
      return `Error: ${source} failed: ${httpError.message}`;
    }
  }
  const message = err instanceof Error ? err.message : String(err);
  return `Error: ${source} failed: ${message}`;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

export async function exaSearch(
  query: string,
  options: ExaSearchOptions = {}
): Promise<string> {
  if (!options.apiKey) {
    return 'Error: exa search requires an apiKey (configure [exa].apiKey).';
  }

  const trimmed = query.trim();
  if (!trimmed) {
    return 'Error: exa search query is empty.';
  }

  const numResults = clampMaxResults(options.maxResults);

  try {
    const data = await got
      .post(EXA_SEARCH_ENDPOINT, {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': options.apiKey,
        },
        json: {
          query: trimmed,
          type: 'auto',
          numResults,
          contents: { highlights: true },
        },
        timeout: { request: EXA_TIMEOUT_MS },
        responseType: 'json',
      })
      .json<ExaSearchResponse>();

    const items = Array.isArray(data.results)
      ? data.results.slice(0, numResults)
      : [];
    if (items.length === 0) {
      return 'exa search returned no results.';
    }

    const blocks = items.map((item, index) => {
      const title = item.title || '(no title)';
      const url = item.url || '(no url)';
      const highlights = Array.isArray(item.highlights)
        ? item.highlights.filter(
            (h): h is string => typeof h === 'string' && h.length > 0
          )
        : [];
      let body: string;
      if (highlights.length > 0) {
        body = highlights.map((h) => truncate(h, 2000)).join('\n');
      } else if (typeof item.text === 'string' && item.text.length > 0) {
        body = truncate(item.text, 2000);
      } else if (typeof item.summary === 'string' && item.summary.length > 0) {
        body = truncate(item.summary, 2000);
      } else {
        body = '';
      }
      return `[${index + 1}] ${title}\nURL: ${url}${body ? `\n${body}` : ''}`;
    });

    return blocks.join('\n\n');
  } catch (err: unknown) {
    log('Error in exaSearch');
    if (err instanceof Error) {
      log(`${err.name}\n${err.message}\n${err.stack}`);
    }
    return formatExaError(err, 'exaSearch');
  }
}
