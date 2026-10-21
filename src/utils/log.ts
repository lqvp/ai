import { Logger } from '@/services/logger.js';

const logger = new Logger('');

/**
 * 既存の `log(msg)` 互換 API。
 * レベル・スコープ付きのロガーに委譲する。
 */
export default function (msg: string): void {
  logger.info(msg);
}
