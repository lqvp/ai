import { describe, expect, it } from 'vitest';
import { deepMerge, getSerif } from '../src/serifs.js';

describe('deepMerge', () => {
  it('replaces a function with a template string using its parameter names', () => {
    const target = { greeting: (name: string) => `こんにちは、${name}` };
    const merged = deepMerge(target, { greeting: 'やあ、{name}！' });

    expect(merged.greeting('藍')).toBe('やあ、藍！');
  });

  it('keeps nested objects and merges them recursively', () => {
    const merged = deepMerge(
      { core: { hello: (name: string) => `hello ${name}`, bye: () => 'bye' } },
      { core: { hello: 'hi {name}' } }
    );

    expect(merged.core.bye()).toBe('bye');
    expect(merged.core.hello('藍')).toBe('hi 藍');
  });

  it('replaces noting.notes wholesale instead of merging', () => {
    const merged = deepMerge(
      { noting: { notes: ['a', 'b'] } },
      { noting: { notes: ['c'] } }
    );
    expect(merged.noting.notes).toEqual(['c']);
  });
});

describe('getSerif', () => {
  it('returns strings as-is and picks from arrays', () => {
    expect(getSerif('そのまま')).toBe('そのまま');
    expect(['a']).toContain(getSerif(['a']));
  });
});
