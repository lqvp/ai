import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';
import {
  type Config,
  ConfigError,
  type RawConfig,
  resolveConfig,
} from './schema.js';

export {
  type Config,
  ConfigError,
  type RawConfig,
  resolveConfig,
} from './schema.js';

/**
 * 設定ファイルを読み込んで解決する。
 */
export function loadConfig(
  path: string = process.env.AI_CONFIG ?? resolve('./config.toml')
): Config {
  if (!existsSync(path)) {
    throw new ConfigError([
      `${path} が見つかりません。example.config.toml をコピーして作成してください`,
    ]);
  }

  let parsed: unknown;
  try {
    parsed = TOML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError([
      `${path} の読み込みに失敗しました: ${(err as Error).message}`,
    ]);
  }

  if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError([`${path} の形式が不正です`]);
  }

  return resolveConfig(parsed as RawConfig);
}

let current: Config | undefined;

/**
 * アプリ起動時に一度だけ設定を注入する。
 */
export function initConfig(config: Config): Config {
  current = config;
  return current;
}

export function getConfig(): Config {
  if (current == null) {
    throw new Error(
      'Config is not initialized. Call initConfig(loadConfig()) at startup.'
    );
  }
  return current;
}

export function hasConfig(): boolean {
  return current != null;
}

/**
 * 既存の `import config from '@/config.js'` との互換用プロキシ。
 * import 時にはファイル I/O を行わない。
 */
const configProxy = new Proxy({} as Config, {
  get(_target, property) {
    return (getConfig() as unknown as Record<PropertyKey, unknown>)[property];
  },
  set(_target, property, value) {
    (getConfig() as unknown as Record<PropertyKey, unknown>)[property] = value;
    return true;
  },
  has(_target, property) {
    return property in getConfig();
  },
  ownKeys() {
    return Reflect.ownKeys(getConfig());
  },
  getOwnPropertyDescriptor(_target, property) {
    return {
      configurable: true,
      enumerable: true,
      value: (getConfig() as unknown as Record<PropertyKey, unknown>)[property],
    };
  },
});

export default configProxy;
