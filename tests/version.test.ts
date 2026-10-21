import { describe, expect, it } from 'vitest';
import { isNewerVersion } from '../src/utils/version.js';

describe('isNewerVersion', () => {
  it('compares numerically, not lexicographically', () => {
    expect(isNewerVersion('3.10.0', '3.9.0')).toBe(true);
    expect(isNewerVersion('3.9.0', '3.10.0')).toBe(false);
  });

  it('ignores leading v and suffixes', () => {
    expect(isNewerVersion('v3.2.6', '3.2.5-lqvp')).toBe(true);
    expect(isNewerVersion('3.2.5', '3.2.5-lqvp')).toBe(false);
  });

  it('pads missing segments with zero', () => {
    expect(isNewerVersion('3.2', '3.2.0')).toBe(false);
    expect(isNewerVersion('3.2.1', '3.2')).toBe(true);
  });
});
