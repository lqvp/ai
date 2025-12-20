import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  checkMissingConfigKeys,
  performStartupConfigCheck,
} from '../built/config-updater.js';

function createCaptureLogger() {
  const logs = [];
  const errors = [];
  return {
    logs,
    errors,
    logger: {
      log: (...args) => logs.push(args.map(String).join(' ')),
      error: (...args) => errors.push(args.map(String).join(' ')),
    },
  };
}

function exitThatThrows() {
  return (code) => {
    const error = new Error(`process.exit: ${code}`);
    error.code = code;
    throw error;
  };
}

test('checkMissingConfigKeys: reports missing keys (top-level + nested)', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-config-test-'));
  const templatePath = path.join(dir, 'example.config.toml');

  await writeFile(
    templatePath,
    `
host = "https://example.test"
i = "token"

[http]
userAgent = "UA-http"

[parent]
a = 1
b = 2
`,
    'utf8'
  );

  const { logger, logs, errors } = createCaptureLogger();

  const userConfig = {
    host: 'https://example.test',
    i: 'token',
    parent: { a: 1 },
  };

  const returned = checkMissingConfigKeys(userConfig, {
    templatePath,
    logger,
  });

  assert.equal(returned, userConfig);
  assert.equal(errors.length, 0);

  const all = logs.join('\n');
  assert.match(all, /以下の設定項目が不足しています/);
  assert.match(all, /📝 http =/);
  assert.match(all, /📝 parent\.b = 2/);
});

test('checkMissingConfigKeys: prints complete when no missing keys', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-config-test-'));
  const templatePath = path.join(dir, 'example.config.toml');

  await writeFile(
    templatePath,
    `
host = "https://example.test"
i = "token"

[parent]
a = 1
`,
    'utf8'
  );

  const { logger, logs } = createCaptureLogger();

  const userConfig = {
    host: 'https://example.test',
    i: 'token',
    parent: { a: 1 },
  };

  checkMissingConfigKeys(userConfig, { templatePath, logger });

  assert.ok(logs.some((l) => l.includes('✅ 設定ファイルは完全です')));
});

test('checkMissingConfigKeys: skips diff check when template is missing', () => {
  const { logger, logs, errors } = createCaptureLogger();

  const userConfig = { host: 'https://example.test', i: 'token' };
  const returned = checkMissingConfigKeys(userConfig, {
    templatePath: '/__does_not_exist__/example.config.toml',
    logger,
  });

  assert.equal(returned, userConfig);
  assert.ok(errors.some((e) => e.includes('❌ 設定差分チェック中にエラー')));
  assert.ok(logs.some((l) => l.includes('設定チェックをスキップ')));
});

test('performStartupConfigCheck: exits when config.toml is missing', () => {
  const { logger } = createCaptureLogger();

  assert.throws(
    () =>
      performStartupConfigCheck({
        configPath: '/__does_not_exist__/config.toml',
        templatePath: '/__does_not_exist__/example.config.toml',
        logger,
        exit: exitThatThrows(),
      }),
    (err) => err && err.code === 1
  );
});

test('performStartupConfigCheck: exits when config.toml is invalid TOML', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-config-test-'));
  const configPath = path.join(dir, 'config.toml');

  await writeFile(configPath, 'host = "https://x"\ninvalid = [\n', 'utf8');

  const { logger } = createCaptureLogger();

  assert.throws(
    () =>
      performStartupConfigCheck({
        configPath,
        templatePath: '/__does_not_exist__/example.config.toml',
        logger,
        exit: exitThatThrows(),
      }),
    (err) => err && err.code === 1
  );
});

test('performStartupConfigCheck: returns parsed config on success', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ai-config-test-'));
  const configPath = path.join(dir, 'config.toml');
  const templatePath = path.join(dir, 'example.config.toml');

  await writeFile(templatePath, 'host = "https://example.test"\ni = "token"\n', 'utf8');
  await writeFile(configPath, 'host = "https://example.test"\ni = "token"\n', 'utf8');

  const { logger } = createCaptureLogger();

  const cfg = performStartupConfigCheck({
    configPath,
    templatePath,
    logger,
    exit: exitThatThrows(),
  });

  assert.equal(cfg.host, 'https://example.test');
  assert.equal(cfg.i, 'token');
});

