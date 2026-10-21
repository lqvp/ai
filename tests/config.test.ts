import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, resolveConfig } from '../src/config.js';

const base = {
  host: 'https://example.com/',
  i: 'token',
};

describe('resolveConfig', () => {
  it('normalizes host and derives urls', () => {
    const config = resolveConfig(base);
    expect(config.host).toBe('https://example.com');
    expect(config.apiUrl).toBe('https://example.com/api');
    expect(config.wsUrl).toBe('wss://example.com');
  });

  it('derives ws:// for http hosts', () => {
    const config = resolveConfig({ ...base, host: 'http://localhost:3000' });
    expect(config.wsUrl).toBe('ws://localhost:3000');
  });

  it('migrates legacy [http]/[websocket] user agents', () => {
    const config = resolveConfig({
      ...base,
      http: { userAgent: 'legacy-http' },
      websocket: { userAgent: 'legacy-ws' },
    });
    expect(config.userAgent).toEqual({
      http: 'legacy-http',
      websocket: 'legacy-ws',
    });
  });

  it('rejects missing host/token', () => {
    expect(() => resolveConfig({})).toThrow(ConfigError);
    expect(() => resolveConfig({ host: 'https://example.com' })).toThrow(
      ConfigError
    );
  });

  it('rejects invalid host and probability', () => {
    expect(() => resolveConfig({ ...base, host: 'example.com' })).toThrow(
      ConfigError
    );
    expect(() =>
      resolveConfig({
        ...base,
        gemini: { autoNote: { probability: 1.5 } },
      })
    ).toThrow(ConfigError);
  });

  it('rejects out-of-range maxResults', () => {
    expect(() =>
      resolveConfig({
        ...base,
        exa: { search: { maxResults: 99 } },
        jenkins: { something: true },
      })
    ).toThrow(ConfigError);
  });

  it('accepts in-range maxResults and ignores unknown sections', () => {
    const config = resolveConfig({
      ...base,
      exa: { search: { maxResults: 3 } },
      jenkins: { something: true },
    });
    expect(config.exa?.search?.maxResults).toBe(3);
  });

  it('strips trailing slashes from wsUrl', () => {
    const config = resolveConfig({ ...base, host: 'https://example.com///' });
    expect(config.wsUrl).toBe('wss://example.com');
  });
});

describe('loadConfig', () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reads and validates a TOML file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-config-'));
    dirs.push(dir);
    const file = join(dir, 'config.toml');
    writeFileSync(
      file,
      'host = "https://example.com"\ni = "token"\nnotingEnabled = true\n',
      'utf8'
    );

    const config = loadConfig(file);
    expect(config.host).toBe('https://example.com');
    expect(config.apiUrl).toBe('https://example.com/api');
    expect(config.notingEnabled).toBe(true);
  });

  it('throws ConfigError when the file is missing', () => {
    expect(() => loadConfig('/nonexistent/config.toml')).toThrow(ConfigError);
  });

  it('throws ConfigError on invalid TOML', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ai-config-'));
    dirs.push(dir);
    const file = join(dir, 'config.toml');
    writeFileSync(file, 'host = ', 'utf8');

    expect(() => loadConfig(file)).toThrow(ConfigError);
  });
});
