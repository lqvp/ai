import type { Config } from '@/config.js';
import { exaSearch } from '@/utils/exa.js';
import { jinaRead } from '@/utils/jina.js';
import { EXA_TOOL_SEARCH, JINA_TOOL_READ } from './constants.js';
import type { OpenaiToolCall } from './types.js';

export async function executeToolCall(
  call: OpenaiToolCall,
  exaConfig: Config['exa'],
  jinaConfig: Config['jina']
): Promise<string> {
  if (call.function.name === EXA_TOOL_SEARCH) {
    return executeExaSearchCall(call, exaConfig);
  }
  if (call.function.name === JINA_TOOL_READ) {
    return executeJinaReadCall(call, jinaConfig?.apiKey, jinaConfig);
  }
  return `Error: unknown tool "${call.function.name}".`;
}

async function executeExaSearchCall(
  call: OpenaiToolCall,
  exaConfig: Config['exa']
): Promise<string> {
  let args: { query?: unknown };
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    if (!parsed || typeof parsed !== 'object') {
      return 'Error: exa_search requires a JSON object argument.';
    }
    args = parsed as { query?: unknown };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Error: exa_search arguments JSON parse failed: ${detail}`;
  }

  if (typeof args.query !== 'string' || args.query.trim() === '') {
    return 'Error: exa_search requires a non-empty "query" string.';
  }

  if (!exaConfig?.apiKey) {
    return 'Error: exa apiKey is not configured (set [exa].apiKey).';
  }

  return await exaSearch(args.query, {
    apiKey: exaConfig.apiKey,
    maxResults: exaConfig?.search?.maxResults,
  });
}

async function executeJinaReadCall(
  call: OpenaiToolCall,
  jinaApiKey: string | undefined,
  jinaConfig: Config['jina']
): Promise<string> {
  let args: { url?: unknown };
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    if (!parsed || typeof parsed !== 'object') {
      return 'Error: jina_read requires a JSON object argument.';
    }
    args = parsed as { url?: unknown };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Error: jina_read arguments JSON parse failed: ${detail}`;
  }

  if (typeof args.url !== 'string' || args.url.trim() === '') {
    return 'Error: jina_read requires a non-empty "url" string.';
  }

  return await jinaRead(args.url, {
    apiKey: jinaApiKey,
    tokenBudget: jinaConfig?.read?.tokenBudget,
  });
}
