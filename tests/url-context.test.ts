import { describe, expect, it } from 'vitest';
import {
  extractUrls,
  formatTimelineContext,
  isPrivateUrl,
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

describe('isPrivateUrl', () => {
  it('rejects localhost and loopback addresses', () => {
    expect(isPrivateUrl('http://localhost:8000/')).toBe(true);
    expect(isPrivateUrl('http://127.0.0.1:3000/')).toBe(true);
    expect(isPrivateUrl('http://[::1]:3000/')).toBe(true);
    expect(isPrivateUrl('http://0.0.0.0/')).toBe(true);
    expect(isPrivateUrl('http://sub.localhost/')).toBe(true);
  });

  it('rejects private and link-local IPv4 ranges', () => {
    expect(isPrivateUrl('http://10.0.0.1/')).toBe(true);
    expect(isPrivateUrl('http://192.168.1.1/')).toBe(true);
    expect(isPrivateUrl('http://172.16.0.1/')).toBe(true);
    expect(isPrivateUrl('http://172.31.255.255/')).toBe(true);
    expect(isPrivateUrl('http://169.254.169.254/')).toBe(true);
  });

  it('rejects metadata endpoints', () => {
    expect(isPrivateUrl('http://metadata.google.internal/')).toBe(true);
  });

  it('rejects IPv6 link-local and unique local addresses', () => {
    expect(isPrivateUrl('http://[fe80::1]/')).toBe(true);
    expect(isPrivateUrl('http://[fd12::1]/')).toBe(true);
  });

  it('rejects IPv4-mapped IPv6 addresses', () => {
    expect(isPrivateUrl('http://[::ffff:127.0.0.1]/')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:10.0.0.1]/')).toBe(true);
    expect(isPrivateUrl('http://[::ffff:169.254.169.254]/')).toBe(true);
  });

  it('allows public hosts', () => {
    expect(isPrivateUrl('https://example.com/')).toBe(false);
    expect(isPrivateUrl('https://8.8.8.8/')).toBe(false);
    expect(isPrivateUrl('https://172.32.0.1/')).toBe(false);
    expect(isPrivateUrl('https://173.16.0.1/')).toBe(false);
    expect(isPrivateUrl('not a url')).toBe(false);
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
