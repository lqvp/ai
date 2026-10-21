import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as TOML from '@iarna/toml';

/**
 * `example.config.toml` とユーザー設定の差分を調べる。
 *
 * 起動時に `process.exit` したりファイルを書き換えたりはしない。
 * 呼び出し側（composition root）が結果をログに出す。
 */

export type MissingKey = {
  key: string;
  defaultValue: unknown;
};

function isObject(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * オブジェクトの深い比較で不足しているキーを検出
 */
export function findMissingKeys(
  userObj: Record<string, unknown>,
  templateObj: Record<string, unknown>,
  prefix = ''
): string[] {
  const missingKeys: string[] = [];

  for (const key of Object.keys(templateObj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (!(key in userObj)) {
      missingKeys.push(fullKey);
    } else if (isObject(templateObj[key]) && isObject(userObj[key])) {
      missingKeys.push(
        ...findMissingKeys(userObj[key], templateObj[key], fullKey)
      );
    }
  }

  return missingKeys;
}

/**
 * ネストしたキーの値を取得
 */
export function getNestedValue(obj: unknown, keyPath: string): unknown {
  let current: unknown = obj;

  for (const key of keyPath.split('.')) {
    if (!isObject(current)) return undefined;
    current = current[key];
  }

  return current;
}

/**
 * 値のプレビュー表示用フォーマット
 */
export function formatValuePreview(value: unknown): string {
  if (typeof value === 'string') {
    if (value.length > 50) {
      return `"${value.substring(0, 47)}..."`;
    }
    return `"${value}"`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    if (value.length === 1) return `["${value[0]}"]`;
    return `["${value[0]}", ...] (${value.length}個)`;
  }
  if (isObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{ ${keys.slice(0, 2).join(', ')}${keys.length > 2 ? ', ...' : ''} }`;
  }
  return String(value);
}

/**
 * 設定テンプレートを読み込む。存在しなければ null。
 */
export function loadConfigTemplate(
  path: string = resolve('./example.config.toml')
): Record<string, unknown> | null {
  if (!existsSync(path)) return null;

  try {
    const parsed = TOML.parse(readFileSync(path, 'utf8'));
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * ユーザー設定に不足しているキーを返す。
 */
export function checkMissingConfigKeys(
  userConfig: Record<string, unknown>,
  template: Record<string, unknown> | null = loadConfigTemplate()
): MissingKey[] {
  if (template == null) return [];

  return findMissingKeys(userConfig, template).map((key) => ({
    key,
    defaultValue: getNestedValue(template, key),
  }));
}
