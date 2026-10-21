import { describe, expect, it } from 'vitest';
import {
  formatApiError,
  getHttpStatus,
  isHttpStatus,
  toError,
} from '../src/services/errors.js';

describe('errors', () => {
  it('reads got-style status codes', () => {
    const err = { response: { statusCode: 404, statusMessage: 'Not Found' } };
    expect(getHttpStatus(err)).toBe(404);
    expect(isHttpStatus(err, 404)).toBe(true);
    expect(formatApiError(err, 'upload')).toContain('HTTP 404');
  });

  it('reads legacy/axios-style status codes', () => {
    expect(getHttpStatus({ statusCode: 500 })).toBe(500);
    expect(getHttpStatus(new Error('boom'))).toBeUndefined();
  });

  it('normalizes non-errors', () => {
    expect(toError('oops')).toBeInstanceOf(Error);
    expect(toError('oops').message).toBe('oops');
    expect(toError({ a: 1 }).message).toBe('{"a":1}');
  });
});
