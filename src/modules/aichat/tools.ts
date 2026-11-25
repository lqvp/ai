import type { Config } from '@/config/index.js';
import { exaSearch } from '@/utils/exa.js';
import { jinaRead } from '@/utils/jina.js';
import { EXA_TOOL_SEARCH, JINA_TOOL_READ } from './constants.js';
import {
  buildMisskeyToolSpecs,
  executeMisskeyToolCall,
  MISSKEY_TOOL_CREATE_REACTION,
  MISSKEY_TOOL_SEARCH_NOTES,
  MISSKEY_TOOL_SEARCH_USERS,
  MISSKEY_TOOL_SHOW_NOTE,
  MISSKEY_TOOL_USER_NOTES,
  type MisskeyToolContext,
} from './misskey-tools.js';
import type { OpenaiFunctionTool, OpenaiToolCall } from './types.js';

/** OpenAI 互換 API に送るツール定義と実行条件。 */
export type OpenaiToolRuntime = {
  tools: OpenaiFunctionTool[];
  hasAnyTool: boolean;
  maxRounds: number;
};

export type BuildOpenaiToolsOptions = {
  allowWebTools?: boolean;
  allowMisskeyTools?: boolean;
};

/**
 * Exa / Jina / Misskey の設定から OpenAI 互換 API 用のツール定義を組み立てる。
 * 権限が許可されないツール群は定義自体を除外する。
 */
export function buildOpenaiTools(
  exaConfig: Config['exa'],
  jinaConfig: Config['jina'],
  misskeyTools?: MisskeyToolContext | null,
  options: BuildOpenaiToolsOptions = {}
): OpenaiToolRuntime {
  const allowWebTools = options.allowWebTools ?? true;
  const allowMisskeyTools = options.allowMisskeyTools ?? true;

  const exaEnabled = allowWebTools && exaConfig?.enabled === true;
  const exaApiKey = exaConfig?.apiKey;
  const exaSearchEnabled = exaConfig?.search?.enabled !== false;
  const jinaEnabled = allowWebTools && jinaConfig?.enabled === true;
  const readEnabled = jinaConfig?.read?.enabled !== false;
  const includeExaSearchTool = exaEnabled && exaSearchEnabled && !!exaApiKey;
  const includeReadTool = jinaEnabled && readEnabled;

  const tools: OpenaiFunctionTool[] = [];
  if (includeExaSearchTool) {
    tools.push({
      type: 'function',
      function: {
        name: EXA_TOOL_SEARCH,
        description:
          'Exa でWeb検索を行い、上位の結果（タイトル/URL/ハイライト本文）を取得します。最新の話題や外部情報を参照したいときに使ってください。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '検索クエリ（自然文）',
            },
          },
          required: ['query'],
        },
      },
    });
  }
  if (includeReadTool) {
    tools.push({
      type: 'function',
      function: {
        name: JINA_TOOL_READ,
        description:
          '指定したURLの本文をJina AI Readerで抽出します。記事やドキュメント本文を読みたいときに使ってください。',
        parameters: {
          type: 'object',
          properties: {
            url: {
              type: 'string',
              description: '読み取り対象のhttp/https URL',
            },
          },
          required: ['url'],
        },
      },
    });
  }

  // Misskey 操作ツール（読み取り系 + リアクション、マスター専用）
  if (allowMisskeyTools && misskeyTools) {
    tools.push(...buildMisskeyToolSpecs(misskeyTools));
  }

  const maxRoundsRaw =
    exaConfig?.tool?.maxRounds ?? jinaConfig?.tool?.maxRounds;
  const parsedMaxRounds =
    typeof maxRoundsRaw === 'number' && !Number.isNaN(maxRoundsRaw)
      ? Math.floor(maxRoundsRaw)
      : 3;

  return {
    tools,
    hasAnyTool: tools.length > 0,
    maxRounds: Math.max(1, parsedMaxRounds),
  };
}

export async function executeToolCall(
  call: OpenaiToolCall,
  exaConfig: Config['exa'],
  jinaConfig: Config['jina'],
  misskeyTools?: MisskeyToolContext | null,
  allowedTools?: ReadonlySet<string>
): Promise<string> {
  if (allowedTools && !allowedTools.has(call.function.name)) {
    return `Error: tool "${call.function.name}" is not allowed.`;
  }
  if (call.function.name === EXA_TOOL_SEARCH) {
    return executeExaSearchCall(call, exaConfig);
  }
  if (call.function.name === JINA_TOOL_READ) {
    return executeJinaReadCall(call, jinaConfig?.apiKey, jinaConfig);
  }
  // 無効化されたリアクションツールへの呼び出しもルーティングできるよう
  // 定義からではなく静的な名前一覧で判定する
  const misskeyToolNames = [
    MISSKEY_TOOL_SEARCH_NOTES,
    MISSKEY_TOOL_SHOW_NOTE,
    MISSKEY_TOOL_SEARCH_USERS,
    MISSKEY_TOOL_USER_NOTES,
    MISSKEY_TOOL_CREATE_REACTION,
  ];
  if (misskeyTools && misskeyToolNames.includes(call.function.name)) {
    return executeMisskeyToolCall(call.function.name, call, misskeyTools);
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
