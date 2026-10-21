/**
 * 設定の公開ファサード。
 *
 * 実装は `src/config/` に分割している:
 * - `schema.ts`  … 型・既定値・バリデーション（純粋関数のみ）
 * - `index.ts`   … TOML の読み込み、起動時のシングルトンと互換プロキシ
 */

export type { Config, RawConfig } from './config/index.js';
export {
  ConfigError,
  default,
  getConfig,
  hasConfig,
  initConfig,
  loadConfig,
  resolveConfig,
} from './config/index.js';
