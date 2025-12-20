import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import * as TOML from '@iarna/toml';
type Config = {
  host: string;
  i: string;
  [key: string]: any; // その他の設定項目
};

export type ConfigCheckLogger = Pick<typeof console, 'log' | 'error'>;

export type StartupConfigCheckOptions = {
  cwd?: string;
  configPath?: string;
  templatePath?: string;
  logger?: ConfigCheckLogger;
  exit?: (code: number) => never;
};

function resolvePathFromOptions(
  opts: StartupConfigCheckOptions | undefined,
  kind: 'config' | 'template'
): string {
  const cwd = opts?.cwd ?? process.cwd();
  if (kind === 'config') return opts?.configPath ?? resolve(cwd, 'config.toml');
  return opts?.templatePath ?? resolve(cwd, 'example.config.toml');
}

function loadConfigTemplate(options?: StartupConfigCheckOptions): Config {
  const templatePath = resolvePathFromOptions(options, 'template');

  if (!existsSync(templatePath)) {
    throw new Error(
      `${templatePath} が見つかりません。テンプレートファイルが必要です。`
    );
  }

  try {
    const templateData = readFileSync(templatePath, 'utf8');
    return TOML.parse(templateData) as Config;
  } catch (error) {
    throw new Error(`${templatePath} の読み込みに失敗しました: ${error}`);
  }
}

/**
 * オブジェクトの深い比較で不足しているキーを検出
 */
function findMissingKeys(
  userObj: any,
  templateObj: any,
  prefix = ''
): string[] {
  const missingKeys: string[] = [];

  for (const key of Object.keys(templateObj)) {
    const fullKey = prefix ? `${prefix}.${key}` : key;

    if (!(key in userObj)) {
      missingKeys.push(fullKey);
    } else if (
      typeof templateObj[key] === 'object' &&
      templateObj[key] !== null &&
      !Array.isArray(templateObj[key]) &&
      typeof userObj[key] === 'object' &&
      userObj[key] !== null
    ) {
      // ネストしたオブジェクトを再帰的にチェック
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
function getNestedValue(obj: any, keyPath: string): any {
  const keys = keyPath.split('.');
  let current = obj;

  for (const key of keys) {
    if (current === null || current === undefined) {
      return undefined;
    }
    current = current[key];
  }

  return current;
}

/**
 * 値のプレビュー表示用フォーマット
 */
function formatValuePreview(value: any): string {
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
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value);
    if (keys.length === 0) return '{}';
    return `{ ${keys.slice(0, 2).join(', ')}${keys.length > 2 ? ', ...' : ''} }`;
  }
  return String(value);
}

/**
 * 設定ファイルの差分チェックと通知
 */
export function checkMissingConfigKeys(
  userConfig: Config,
  options?: StartupConfigCheckOptions
): Config {
  const logger = options?.logger ?? console;
  logger.log('🔍 設定ファイルチェックを開始します');

  try {
    // テンプレートを読み込み
    const template = loadConfigTemplate(options);

    // 不足しているキーを検出
    const missingKeys = findMissingKeys(userConfig, template);

    if (missingKeys.length === 0) {
      logger.log('✅ 設定ファイルは完全です');
      return userConfig;
    }

    logger.log(
      `\n📋 以下の設定項目が不足しています (${missingKeys.length}個):`
    );
    logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

    missingKeys.forEach((key) => {
      const defaultValue = getNestedValue(template, key);
      const valuePreview = formatValuePreview(defaultValue);
      logger.log(`   📝 ${key} = ${valuePreview}`);
    });

    logger.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    logger.log('💡 これらの設定を config.toml に追加することをお勧めします');
    logger.log('📖 詳細は example.config.toml を参照してください');

    return userConfig;
  } catch (error) {
    logger.error('❌ 設定差分チェック中にエラーが発生しました:', error);
    logger.log('⚠️  設定チェックをスキップして起動を続行します');
    return userConfig;
  }
}

/**
 * 起動時の設定チェック（メイン関数）
 */
export function performStartupConfigCheck(
  options?: StartupConfigCheckOptions
): Config {
  const logger = options?.logger ?? console;
  const exit = options?.exit ?? ((code: number) => process.exit(code) as never);

  logger.log('🚀 藍 (Ai) 起動中...');
  logger.log('📋 設定ファイルチェックを開始します');

  const configPath = resolvePathFromOptions(options, 'config');

  if (!existsSync(configPath)) {
    logger.error('❌ config.toml が見つかりません');
    logger.log(
      '💡 example.config.toml をコピーして config.toml を作成してください'
    );
    return exit(1);
  }

  try {
    // 現在の設定を読み込み
    const configData = readFileSync(configPath, 'utf8');
    const userConfig = TOML.parse(configData) as Config;

    // 設定差分チェックと通知
    const checkedConfig = checkMissingConfigKeys(userConfig, options);

    logger.log('✅ 設定ファイルチェック完了');
    logger.log('🎉 Bot起動準備完了！');

    return checkedConfig;
  } catch (error) {
    logger.error('❌ 設定ファイルの読み込みに失敗しました:', error);
    return exit(1);
  }
}
