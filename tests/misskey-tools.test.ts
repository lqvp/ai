import { describe, expect, it } from 'vitest';
import {
  buildMisskeyToolSpecs,
  executeMisskeyToolCall,
  type MisskeyToolContext,
} from '../src/modules/aichat/misskey-tools.js';

const api = async (endpoint: string, param?: Record<string, unknown>) => {
  return { endpoint, param };
};

const ctx = (
  overrides: Partial<MisskeyToolContext> = {}
): MisskeyToolContext => ({
  api,
  allowReaction: true,
  ...overrides,
});

const call = (name: string, args: unknown) => ({
  id: 'call1',
  function: { name, arguments: JSON.stringify(args) },
});

describe('buildMisskeyToolSpecs', () => {
  it('includes read tools and reaction when allowed', () => {
    const specs = buildMisskeyToolSpecs(ctx());
    const names = specs.map((s) => s.function.name);
    expect(names).toEqual([
      'misskey_search_notes',
      'misskey_show_note',
      'misskey_search_users',
      'misskey_user_notes',
      'misskey_create_reaction',
    ]);
  });

  it('omits the reaction tool when disallowed', () => {
    const names = buildMisskeyToolSpecs(ctx({ allowReaction: false })).map(
      (s) => s.function.name
    );
    expect(names).not.toContain('misskey_create_reaction');
    expect(names).toHaveLength(4);
  });
});

describe('executeMisskeyToolCall', () => {
  it('calls notes/search with clamped limit', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_search_notes',
      call('misskey_search_notes', { query: 'hello', limit: 100 }),
      ctx()
    );
    const parsed = JSON.parse(result);
    expect(parsed.endpoint).toBe('notes/search');
    expect(parsed.param.limit).toBe(20);
    expect(parsed.param.query).toBe('hello');
  });

  it('calls notes/show with the noteId', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_show_note',
      call('misskey_show_note', { noteId: 'note1' }),
      ctx()
    );
    expect(JSON.parse(result).endpoint).toBe('notes/show');
  });

  it('calls users/search with a default limit', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_search_users',
      call('misskey_search_users', { query: 'ai' }),
      ctx()
    );
    const parsed = JSON.parse(result);
    expect(parsed.endpoint).toBe('users/search');
    expect(parsed.param.limit).toBe(5);
  });

  it('calls users/notes for user timelines', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_user_notes',
      call('misskey_user_notes', { userId: 'u1' }),
      ctx()
    );
    expect(JSON.parse(result).endpoint).toBe('users/notes');
  });

  it('calls notes/reactions/create when allowed', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_create_reaction',
      call('misskey_create_reaction', { noteId: 'n1', emoji: '👍' }),
      ctx({ allowReaction: true })
    );
    expect(result).toBe('リアクション(👍)を付けました。');
  });

  it('rejects the reaction tool when disabled', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_create_reaction',
      call('misskey_create_reaction', { noteId: 'n1', emoji: '👍' }),
      ctx({ allowReaction: false })
    );
    expect(result).toBe('Error: reaction tool is disabled by configuration.');
  });

  it('returns an error string for invalid arguments', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_search_notes',
      {
        id: 'call1',
        function: { name: 'misskey_search_notes', arguments: '{invalid' },
      },
      ctx()
    );
    expect(result).toContain('JSON parse failed');
  });

  it('returns an error string for empty required params', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_search_notes',
      call('misskey_search_notes', { query: '' }),
      ctx()
    );
    expect(result).toContain('requires a non-empty "query" string');
  });

  it('returns an error string for unknown tools', async () => {
    const result = await executeMisskeyToolCall(
      'misskey_unknown',
      call('misskey_unknown', {}),
      ctx()
    );
    expect(result).toBe('Error: unknown misskey tool "misskey_unknown".');
  });

  it('surfaces API errors as strings', async () => {
    const failing: MisskeyToolContext = {
      api: async () => {
        throw new Error('boom');
      },
      allowReaction: true,
    };
    const result = await executeMisskeyToolCall(
      'misskey_show_note',
      call('misskey_show_note', { noteId: 'n1' }),
      failing
    );
    expect(result).toBe('Error: notes/show failed: boom');
  });
});

describe('reaction tool edge cases', () => {
  it('reports success when the API returns an empty body (204)', async () => {
    const noBody: MisskeyToolContext = {
      api: async () => undefined,
      allowReaction: true,
    };
    const result = await executeMisskeyToolCall(
      'misskey_create_reaction',
      call('misskey_create_reaction', { noteId: 'n1', emoji: '❤️' }),
      noBody
    );
    expect(result).toBe('リアクション(❤️)を付けました。');
  });

  it('treats already-reacted as a skip instead of an error', async () => {
    const conflicted: MisskeyToolContext = {
      api: async () => {
        throw new Error('You are already reacting to that note.');
      },
      allowReaction: true,
    };
    const result = await executeMisskeyToolCall(
      'misskey_create_reaction',
      call('misskey_create_reaction', { noteId: 'n1', emoji: '❤️' }),
      conflicted
    );
    expect(result).toBe(
      'このノートにはすでにリアクション済みのため、スキップしました。'
    );
  });
});
