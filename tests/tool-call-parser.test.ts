import { describe, expect, it } from 'vitest';
import { parseToolCallsFromContent } from '../src/modules/aichat/tool-call-parser.js';

describe('parseToolCallsFromContent', () => {
  it('returns empty result for plain content', () => {
    const result = parseToolCallsFromContent('hello');
    expect(result.toolCalls).toEqual([]);
    expect(result.cleanedContent).toBe('hello');
  });

  it('extracts a tool call and removes it from content', () => {
    const content =
      '調べます。\nfunctions.exa_search:0 {"query":"Misskey"}\n完了しました。';
    const result = parseToolCallsFromContent(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('exa_search');
    expect(JSON.parse(result.toolCalls[0].function.arguments)).toEqual({
      query: 'Misskey',
    });
    expect(result.cleanedContent).toContain('調べます。');
    expect(result.cleanedContent).toContain('完了しました。');
    expect(result.cleanedContent).not.toContain('functions.exa_search');
  });

  it('handles nested braces inside JSON strings', () => {
    const content = 'functions.jina_read:0 {"url":"https://example.com/{a}"}';
    const result = parseToolCallsFromContent(content);
    expect(result.toolCalls).toHaveLength(1);
    expect(result.toolCalls[0].function.name).toBe('jina_read');
  });
});
