import { describe, expect, it } from 'vitest';
import {
  extractUrls,
  formatTimelineContext,
  isYoutubeUrl,
  normalizeYoutubeUrl,
} from '../src/modules/aichat/url-context.js';

describe('isYoutubeUrl', () => {
  it('detects youtube hosts', () => {
    expect(isYoutubeUrl('https://www.youtube.com/watch?v=abc')).toBe(true);
    expect(isYoutubeUrl('https://m.youtube.com/watch?v=abc')).toBe(true);
    expect(isYoutubeUrl('https://youtu.be/abc')).toBe(true);
    expect(isYoutubeUrl('https://example.com/abc')).toBe(false);
  });
});

describe('normalizeYoutubeUrl', () => {
  it('normalizes youtu.be and youtube.com URLs', () => {
    expect(normalizeYoutubeUrl('https://youtu.be/abc?t=10')).toBe(
      'https://www.youtube.com/watch?v=abc'
    );
    expect(
      normalizeYoutubeUrl('https://www.youtube.com/watch?v=xyz&feature=share')
    ).toBe('https://www.youtube.com/watch?v=xyz');
  });

  it('returns the original URL when it cannot be parsed', () => {
    expect(normalizeYoutubeUrl('not a url')).toBe('not a url');
  });
});

describe('extractUrls', () => {
  it('finds multiple URLs in text', () => {
    expect(
      extractUrls('見て https://example.com/a と https://youtu.be/b です')
    ).toEqual(['https://example.com/a', 'https://youtu.be/b']);
  });
});

describe('formatTimelineContext', () => {
  it('returns an empty string for missing context', () => {
    expect(formatTimelineContext(null)).toBe('');
  });

  it('lists before/after posts with numbering when needed', () => {
    const text = formatTimelineContext({
      before: [{ text: 'ひとつ前' }, { text: 'ふたつ前' }],
      after: [{ text: 'その後' }],
    });

    expect(text).toContain('ユーザー投稿履歴文脈情報');
    expect(text).toContain('以前の投稿(1): ひとつ前');
    expect(text).toContain('以前の投稿(2): ふたつ前');
    expect(text).toContain('その後の投稿: その後');
  });
});
