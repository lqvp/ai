import { describe, expect, it } from 'vitest';
import includes from '../src/utils/includes.js';
import { bold, color } from '../src/utils/mfm.js';
import or from '../src/utils/or.js';

describe('includes', () => {
  it('matches katakana/hiragana and half/full width', () => {
    expect(includes('アイチャット', ['あいちゃっと'])).toBe(true);
    expect(includes('ｱｲﾁｬｯﾄ', ['アイチャット'])).toBe(true);
    expect(includes('hello', ['HELLO'])).toBe(true);
    expect(includes('hello', ['world'])).toBe(false);
  });
});

describe('or', () => {
  it('matches strings and regexps', () => {
    expect(or('天気を教えて', ['天気', /教えて/])).toBe(true);
    expect(or('地震です', ['天気'])).toBe(false);
  });
});

describe('mfm', () => {
  it('wraps text with MFM syntax', () => {
    expect(bold('x')).toBe('**x**');
    expect(color('x', 'ff0000')).toBe('$[fg.color=ff0000 x]');
  });
});
