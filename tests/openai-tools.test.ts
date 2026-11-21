import { describe, expect, it } from 'vitest';
import type { MisskeyToolContext } from '../src/modules/aichat/misskey-tools.js';
import {
  buildOpenaiTools,
  executeToolCall,
} from '../src/modules/aichat/tools.js';

const exa = (overrides: Record<string, unknown> = {}) =>
  ({ enabled: true, apiKey: 'exa-key', ...overrides }) as any;
const jina = (overrides: Record<string, unknown> = {}) =>
  ({ enabled: true, ...overrides }) as any;

const misskeyCtx = (
  overrides: Partial<MisskeyToolContext> = {}
): MisskeyToolContext => ({
  api: async (endpoint: string, param?: Record<string, unknown>) => ({
    endpoint,
    param,
  }),
  allowReaction: true,
  ...overrides,
});

describe('buildOpenaiTools', () => {
  it('builds both tools when exa and jina are enabled', () => {
    const runtime = buildOpenaiTools(exa(), jina());
    expect(runtime.tools.map((t) => t.function.name)).toEqual([
      'exa_search',
      'jina_read',
    ]);
    expect(runtime.hasAnyTool).toBe(true);
    expect(runtime.maxRounds).toBe(3);
  });

  it('omits exa_search when the exa apiKey is missing', () => {
    const runtime = buildOpenaiTools(exa({ apiKey: undefined }), jina());
    expect(runtime.tools.map((t) => t.function.name)).toEqual(['jina_read']);
    expect(runtime.hasAnyTool).toBe(true);
  });

  it('omits jina_read when jina read is disabled', () => {
    const runtime = buildOpenaiTools(exa(), jina({ read: { enabled: false } }));
    expect(runtime.tools.map((t) => t.function.name)).toEqual(['exa_search']);
  });

  it('returns no tools when both are disabled', () => {
    const runtime = buildOpenaiTools(
      { enabled: false, apiKey: 'exa-key' },
      { enabled: false }
    );
    expect(runtime.tools).toEqual([]);
    expect(runtime.hasAnyTool).toBe(false);
  });

  it('honors maxRounds from tool config and clamps invalid values', () => {
    expect(
      buildOpenaiTools(exa(), jina({ tool: { maxRounds: 5 } })).maxRounds
    ).toBe(5);
    expect(
      buildOpenaiTools(exa({ tool: { maxRounds: 0 } }), jina()).maxRounds
    ).toBe(1);
    expect(
      buildOpenaiTools(exa({ tool: { maxRounds: Number.NaN } }), jina())
        .maxRounds
    ).toBe(3);
  });
});

describe('buildOpenaiTools with misskey tools', () => {
  it('appends misskey tools to exa/jina tools', () => {
    const runtime = buildOpenaiTools(exa(), jina(), misskeyCtx());
    const names = runtime.tools.map((t) => t.function.name);
    expect(names).toContain('misskey_search_notes');
    expect(names).toContain('misskey_create_reaction');
    expect(runtime.hasAnyTool).toBe(true);
  });

  it('omits the reaction tool when disallowed', () => {
    const runtime = buildOpenaiTools(
      exa(),
      jina(),
      misskeyCtx({ allowReaction: false })
    );
    const names = runtime.tools.map((t) => t.function.name);
    expect(names).toContain('misskey_search_notes');
    expect(names).not.toContain('misskey_create_reaction');
  });

  it('uses misskey tools alone when exa/jina are disabled', () => {
    const runtime = buildOpenaiTools(undefined, undefined, misskeyCtx());
    expect(runtime.hasAnyTool).toBe(true);
    expect(runtime.tools.length).toBeGreaterThan(0);
  });

  it('returns no tools when misskey context is absent', () => {
    const runtime = buildOpenaiTools(undefined, undefined, null);
    expect(runtime.tools).toEqual([]);
    expect(runtime.hasAnyTool).toBe(false);
  });
});

describe('executeToolCall routing', () => {
  it('routes misskey tool calls to the misskey executor', async () => {
    const call = {
      id: 'call1',
      type: 'function' as const,
      function: {
        name: 'misskey_search_notes',
        arguments: '{"query":"hello"}',
      },
    };
    const result = await executeToolCall(
      call,
      undefined,
      undefined,
      misskeyCtx()
    );
    const parsed = JSON.parse(result);
    expect(parsed.endpoint).toBe('notes/search');
  });

  it('routes the reaction tool even when disallowed', async () => {
    const call = {
      id: 'call2',
      type: 'function' as const,
      function: {
        name: 'misskey_create_reaction',
        arguments: '{"noteId":"n1","emoji":"👍"}',
      },
    };
    const result = await executeToolCall(
      call,
      undefined,
      undefined,
      misskeyCtx({ allowReaction: false })
    );
    expect(result).toBe('Error: reaction tool is disabled by configuration.');
  });

  it('returns unknown tool error for other names', async () => {
    const call = {
      id: 'call3',
      type: 'function' as const,
      function: { name: 'nonexistent_tool', arguments: '{}' },
    };
    const result = await executeToolCall(
      call,
      undefined,
      undefined,
      misskeyCtx()
    );
    expect(result).toBe('Error: unknown tool "nonexistent_tool".');
  });
});
