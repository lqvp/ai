// AiOS bootstrapper

import process from 'node:process';
import chalk from 'chalk';
import got from 'got';
// import pkg from '../package.json' assert { type: 'json' };
import { createRequire } from 'module';
import promiseRetry from 'promise-retry';
import type { User } from '@/misskey/user.js';
import 藍 from './ai.js';
import config, { type Config, initConfig, loadConfig } from './config.js';
import { checkMissingConfigKeys } from './config-updater.js';
import _log from './utils/log.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

import { createModules } from './modules/registry.js';

console.log('   __    ____  _____  ___ ');
console.log('  /__\\  (_  _)(  _  )/ __)');
console.log(' /(__)\\  _)(_  )(_)( \\__ \\');
console.log('(__)(__)(____)(_____)(___/\n');

function log(msg: string): void {
  _log(`[Boot]: ${msg}`);
}

log(chalk.bold(`Ai v${pkg._v}`));

// 設定はここ（composition root）で一度だけ読み込む。
// モジュールの import 時に config.toml を要求しない。
let appConfig: Config;
try {
  appConfig = initConfig(loadConfig());
} catch (err) {
  log(chalk.red('Failed to load config.toml'));
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}

const missingKeys = checkMissingConfigKeys(
  appConfig as unknown as Record<string, unknown>
);
if (missingKeys.length > 0) {
  log(
    chalk.yellow(
      `config.toml に ${missingKeys.length} 個の不足キーがあります（example.config.toml を参照）`
    )
  );
  for (const { key, defaultValue } of missingKeys.slice(0, 20)) {
    log(chalk.gray(`  - ${key} = ${String(defaultValue)}`));
  }
}

process.on('uncaughtException', (err) => {
  try {
    console.error(`Uncaught exception: ${err.message}`);
    console.dir(err, { colors: true, depth: 2 });
  } catch {}
});

process.on('unhandledRejection', (reason) => {
  try {
    console.error('Unhandled rejection:', reason);
  } catch {}
});

let ai: 藍 | undefined;

const shutdown = (signal: string): void => {
  log(`Received ${signal}, shutting down...`);
  void (ai?.stop() ?? Promise.resolve()).finally(() => {
    process.exit(0);
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

promiseRetry(
  (retry) => {
    log(`Account fetching... ${chalk.gray(config.host)}`);

    // アカウントをフェッチ
    return got
      .post(`${config.apiUrl}/i`, {
        json: {
          i: config.i,
        },
        headers: {
          'User-Agent':
            config.userAgent?.http ||
            'Misskey-Ai-Bot(https://github.com/lqvp/ai)',
        },
      })
      .json<User>()
      .catch(retry);
  },
  {
    retries: 3,
  }
)
  .then((account) => {
    const acct = `@${account.username}`;
    log(chalk.green(`Account fetched successfully: ${chalk.underline(acct)}`));

    log('Starting AiOS...');

    // 藍起動
    ai = new 藍(account, createModules());
  })
  .catch(() => {
    log(chalk.red('Failed to fetch the account'));
  });
