import { describe, expect, it } from 'vitest';
import {
  findMissingKeys,
  formatValuePreview,
  getNestedValue,
} from '../src/config-updater.js';

describe('config-updater', () => {
  it('finds nested missing keys', () => {
    const missing = findMissingKeys(
      { gemini: { enabled: true } },
      { gemini: { enabled: false, model: 'x' }, host: '' }
    );
    expect(missing).toEqual(['gemini.model', 'host']);
  });

  it('does not report present keys', () => {
    expect(findMissingKeys({ a: { b: 1 } }, { a: { b: 2 } })).toEqual([]);
  });

  it('reads nested values', () => {
    expect(getNestedValue({ a: { b: 3 } }, 'a.b')).toBe(3);
    expect(getNestedValue({ a: null }, 'a.b')).toBeUndefined();
  });

  it('formats previews', () => {
    expect(formatValuePreview('abc')).toBe('"abc"');
    expect(formatValuePreview([1, 2, 3])).toContain('3個');
    expect(formatValuePreview({ a: 1 })).toBe('{ a }');
  });
});
