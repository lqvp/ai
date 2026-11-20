import type { OpenaiFunctionTool } from './types.js';

/**
 * Misskey API を呼び出す最小限のインターフェース。
 * `ai.api` から簡単に作れる（テストでもモックしやすい）。
 */
export type MisskeyApiCall = (
  endpoint: string,
  param?: Record<string, unknown>
) => Promise<unknown>;

export type MisskeyToolContext = {
  api: MisskeyApiCall;
  /** notes/reactions/create を有効にするか（書き込み操作のため設定で止められる） */
  allowReaction: boolean;
};

/**
 * 検索・参照系ツール。取得結果はそのまま LLM のコンテキストに入るため、
 * 投稿本文などは信頼できない第三者コンテンツとして扱われる点に注意。
 */
export const MISSKEY_TOOL_SEARCH_NOTES = 'misskey_search_notes';
export const MISSKEY_TOOL_SHOW_NOTE = 'misskey_show_note';
export const MISSKEY_TOOL_SEARCH_USERS = 'misskey_search_users';
export const MISSKEY_TOOL_USER_NOTES = 'misskey_user_notes';
export const MISSKEY_TOOL_CREATE_REACTION = 'misskey_create_reaction';

const MAX_RESULT_CHARS = 8000;

/** LLM に渡すツール定義（読み取り系 + リアクション）。 */
export function buildMisskeyToolSpecs(
  ctx: MisskeyToolContext
): OpenaiFunctionTool[] {
  const tools: OpenaiFunctionTool[] = [
    {
      type: 'function',
      function: {
        name: MISSKEY_TOOL_SEARCH_NOTES,
        description:
          'Misskeyのサーバー内ノートを全文検索します。過去の会話や話題を調べたいときに使ってください。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '検索クエリ',
            },
            limit: {
              type: 'number',
              description: '取得件数（最大20）',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: MISSKEY_TOOL_SHOW_NOTE,
        description:
          '指定したIDのノートを詳細表示します。会話チェーンの確認に使ってください。',
        parameters: {
          type: 'object',
          properties: {
            noteId: {
              type: 'string',
              description: 'ノートID',
            },
          },
          required: ['noteId'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: MISSKEY_TOOL_SEARCH_USERS,
        description:
          'Misskeyのユーザーを検索します。ユーザーについての情報を調べたいときに使ってください。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '検索クエリ',
            },
            limit: {
              type: 'number',
              description: '取得件数（最大10）',
            },
          },
          required: ['query'],
        },
      },
    },
    {
      type: 'function',
      function: {
        name: MISSKEY_TOOL_USER_NOTES,
        description:
          '指定したユーザーの投稿一覧を取得します。発言の文脈を知りたいときに使ってください。',
        parameters: {
          type: 'object',
          properties: {
            userId: {
              type: 'string',
              description: 'ユーザーID',
            },
            limit: {
              type: 'number',
              description: '取得件数（最大20）',
            },
          },
          required: ['userId'],
        },
      },
    },
  ];

  if (ctx.allowReaction) {
    tools.push({
      type: 'function',
      function: {
        name: MISSKEY_TOOL_CREATE_REACTION,
        description:
          '指定したノートに絵文字リアクションを付けます。ユーザーとの雑談を盛り上げるために使ってください。',
        parameters: {
          type: 'object',
          properties: {
            noteId: {
              type: 'string',
              description: 'ノートID',
            },
            emoji: {
              type: 'string',
              description:
                'リアクションに使う絵文字（例: 👍, ❗）。カスタム絵文字は :emoji_name: 形式。',
            },
          },
          required: ['noteId', 'emoji'],
        },
      },
    });
  }

  return tools;
}

/** APIの結果を LLM コンテキストに収まるよう文字列化する。 */
function stringifyResult(value: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    return 'Error: failed to serialize API result.';
  }
  // notes/reactions/create などボディなしの成功 (204) は undefined になる
  if (text === undefined) return 'API call succeeded (no response body).';
  if (text == null) return 'Error: API returned empty result.';
  return text.slice(0, MAX_RESULT_CHARS);
}

async function callApi(
  ctx: MisskeyToolContext,
  endpoint: string,
  param: Record<string, unknown>
): Promise<string> {
  try {
    const result = await ctx.api(endpoint, param);
    return stringifyResult(result);
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return `Error: ${endpoint} failed: ${detail}`;
  }
}

function parseArgs(call: { function: { arguments?: string } }): {
  ok: boolean;
  value?: Record<string, unknown>;
  error?: string;
} {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { ok: false, error: 'arguments must be a JSON object.' };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `arguments JSON parse failed: ${detail}` };
  }
}

function clampLimit(value: unknown, max: number, fallback: number): number {
  if (typeof value !== 'number' || Number.isNaN(value) || value < 1) {
    return fallback;
  }
  return Math.min(Math.floor(value), max);
}

function requireString(
  args: Record<string, unknown>,
  key: string
): { ok: true; value: string } | { ok: false; error: string } {
  const value = args[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return { ok: false, error: `requires a non-empty "${key}" string.` };
  }
  return { ok: true, value };
}

/** ツール呼び出しを実行する。結果は必ず文字列で返す（エラーも含む）。 */
export async function executeMisskeyToolCall(
  name: string,
  call: { id?: string; function: { name: string; arguments?: string } },
  ctx: MisskeyToolContext
): Promise<string> {
  const parsed = parseArgs(call);
  if (!parsed.ok) return `Error: ${call.function.name} ${parsed.error}`;
  const args = parsed.value as Record<string, unknown>;

  switch (name) {
    case MISSKEY_TOOL_SEARCH_NOTES: {
      const query = requireString(args, 'query');
      if (!query.ok) return `Error: ${name} ${query.error}`;
      return await callApi(ctx, 'notes/search', {
        query: query.value,
        limit: clampLimit(args.limit, 20, 10),
      });
    }
    case MISSKEY_TOOL_SHOW_NOTE: {
      const noteId = requireString(args, 'noteId');
      if (!noteId.ok) return `Error: ${name} ${noteId.error}`;
      return await callApi(ctx, 'notes/show', { noteId: noteId.value });
    }
    case MISSKEY_TOOL_SEARCH_USERS: {
      const query = requireString(args, 'query');
      if (!query.ok) return `Error: ${name} ${query.error}`;
      return await callApi(ctx, 'users/search', {
        query: query.value,
        limit: clampLimit(args.limit, 10, 5),
      });
    }
    case MISSKEY_TOOL_USER_NOTES: {
      const userId = requireString(args, 'userId');
      if (!userId.ok) return `Error: ${name} ${userId.error}`;
      return await callApi(ctx, 'users/notes', {
        userId: userId.value,
        limit: clampLimit(args.limit, 20, 10),
      });
    }
    case MISSKEY_TOOL_CREATE_REACTION: {
      if (!ctx.allowReaction) {
        return 'Error: reaction tool is disabled by configuration.';
      }
      const noteId = requireString(args, 'noteId');
      if (!noteId.ok) return `Error: ${name} ${noteId.error}`;
      const emoji = requireString(args, 'emoji');
      if (!emoji.ok) return `Error: ${name} ${emoji.error}`;
      try {
        await ctx.api('notes/reactions/create', {
          noteId: noteId.value,
          reaction: emoji.value,
        });
        return `リアクション(${emoji.value})を付けました。`;
      } catch (err: unknown) {
        const detail = err instanceof Error ? err.message : String(err);
        // Misskeyは1ノートに1ユーザー1リアクション。すでに付いている場合は衝突しない
        if (/already react/i.test(detail)) {
          return 'このノートにはすでにリアクション済みのため、スキップしました。';
        }
        return `Error: notes/reactions/create failed: ${detail}`;
      }
    }
    default:
      return `Error: unknown misskey tool "${name}".`;
  }
}
