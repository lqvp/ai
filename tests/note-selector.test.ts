import { describe, expect, it } from 'vitest';
import { parseSelection } from '../src/modules/aichat/note-selector.js';

describe('parseSelection', () => {
  it('parses a valid index from JSON', () => {
    expect(parseSelection('{"index": 3}', 10)).toBe(3);
  });

  it('extracts JSON from surrounding text', () => {
    expect(parseSelection('はい、こちらです: {"index": 1} 以上です。', 5)).toBe(
      1
    );
  });

  it('returns null when the model decides not to reply', () => {
    expect(parseSelection('{"index": null}', 5)).toBeNull();
  });

  it('rejects out-of-range indexes', () => {
    expect(parseSelection('{"index": 10}', 5)).toBeNull();
    expect(parseSelection('{"index": -1}', 5)).toBeNull();
  });

  it('rejects non-integer and non-numeric indexes', () => {
    expect(parseSelection('{"index": 1.5}', 5)).toBeNull();
    expect(parseSelection('{"index": "2"}', 5)).toBeNull();
    expect(parseSelection('{"index": true}', 5)).toBeNull();
  });

  it('returns null for invalid JSON or missing braces', () => {
    expect(parseSelection('no json here', 5)).toBeNull();
    expect(parseSelection('{broken', 5)).toBeNull();
    expect(parseSelection('', 5)).toBeNull();
  });
});
