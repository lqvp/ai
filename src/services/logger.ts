/**
 * 構造化ロガー。
 *
 * これまで `console.log` / `console.error` / chalk 付きの独自ログが混在していた。
 * 出力先は今まで通り stdout/stderr だが、スコープと重要度を持つことで
 * 本番ログを絞り込みやすくする。
 */

import chalk from 'chalk';
import { errorToString, toError } from './errors.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LEVEL_LABEL: Record<LogLevel, string> = {
  debug: chalk.gray('DEBUG'),
  info: chalk.cyan('INFO'),
  warn: chalk.yellow('WARN'),
  error: chalk.red('ERROR'),
};

function pad2(value: number): string {
  return value.toString().padStart(2, '0');
}

function timestamp(): string {
  const now = new Date();
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}:${pad2(now.getSeconds())}`;
}

function resolveMinLevel(): LogLevel {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
    return raw;
  }
  return 'info';
}

export class Logger {
  private readonly scope: string;

  constructor(scope: string = 'AiOS') {
    this.scope = scope;
  }

  public child(scope: string): Logger {
    return new Logger(this.scope === '' ? scope : `${this.scope}:${scope}`);
  }

  public debug(message: string, ...args: unknown[]): void {
    this.write('debug', message, args);
  }

  public info(message: string, ...args: unknown[]): void {
    this.write('info', message, args);
  }

  public warn(message: string, ...args: unknown[]): void {
    this.write('warn', message, args);
  }

  public error(message: string, error?: unknown, ...args: unknown[]): void {
    const all = error === undefined ? args : [error, ...args];
    this.write('error', message, all);
  }

  private write(level: LogLevel, message: string, args: unknown[]): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[resolveMinLevel()]) return;

    const scope = this.scope ? chalk.magenta(`[${this.scope}]`) : '';
    const head = `${chalk.gray(timestamp())} ${LEVEL_LABEL[level]} ${scope}`;
    const text = `${head} ${message}`;

    const remaining = args.filter((arg) => arg !== undefined);
    if (remaining.length === 0) {
      console.log(text);
      return;
    }

    const formatted = remaining.map((arg) => this.formatArg(arg));
    console.log(`${text} ${formatted.join(' ')}`);
  }

  private formatArg(arg: unknown): string {
    if (arg instanceof Error) {
      return errorToString(arg);
    }
    if (typeof arg === 'string') {
      return arg;
    }
    try {
      return JSON.stringify(arg);
    } catch {
      return String(arg);
    }
  }
}

export const logger = new Logger('AiOS');

/**
 * 既存の `utils/log` 互換のシンプルなログ関数。
 */
export function logMessage(message: string): void {
  logger.info(message);
}

export { toError };
