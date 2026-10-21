import { createRequire } from 'node:module';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace NodeJS {
    interface Global {
      gc?(minor?: boolean): void;
      gc?(options: { type?: 'major' | 'minor' | 'major-snapshot' }): void;
      gc?(options: {
        type?: 'major' | 'minor' | 'major-snapshot';
        execution: 'async';
      }): Promise<void>;
    }
  }
}

export type GCType =
  | 'major'
  | 'minor'
  | 'full'
  | 'incremental'
  | 'unknown'
  | 'none'
  | 'major-snapshot';

const require = createRequire(import.meta.url);

let version = 'unknown';
let gcRestore: (() => void) | null = null;

const gcStats = {
  totalGCTime: 0,
  totalGCCount: 0,
  lastGCType: 'none' as GCType,
  lastGCDuration: 0,
};

function isPromise(p: any): p is Promise<any> {
  return p !== null && typeof p === 'object' && typeof p.then === 'function';
}

export function initializeVersion(): void {
  try {
    const pkg = require('../../package.json');
    version = pkg._v || pkg.version || 'development';
  } catch {
    version = 'development';
  }
}

export function getVersion(): string {
  return version;
}

export function getGcStats(): typeof gcStats {
  return gcStats;
}

function updateGCStats(
  start: [number, number],
  type: GCType = 'unknown'
): void {
  const diff = process.hrtime(start);
  const duration = diff[0] * 1000 + diff[1] / 1e6; // ms

  gcStats.totalGCTime += duration;
  gcStats.totalGCCount++;
  gcStats.lastGCType = type;
  gcStats.lastGCDuration = duration;
}

/**
 * GC 監視をセットアップし、元に戻す関数を返す。
 * `--expose-gc` が無い場合は何もしない。
 */
export function setupGCMonitoring(enabled: boolean): () => void {
  if (!enabled || typeof global.gc !== 'function') {
    console.warn(
      'GC function is not available. To enable, run Node.js with the --expose-gc flag.'
    );
    return () => {};
  }

  const originalGC = global.gc;

  const wrappedGC = (
    arg?:
      | boolean
      | { type?: 'major' | 'minor' | 'major-snapshot'; execution?: 'async' }
  ): undefined | Promise<void> => {
    const start = process.hrtime();
    try {
      let result: any;
      let gcType: GCType = 'unknown';

      if (typeof arg === 'boolean') {
        result = originalGC(arg);
        gcType = arg ? 'major' : 'minor';
      } else if (arg && typeof arg === 'object') {
        result = originalGC(arg);
        gcType = arg.type || 'unknown';
      } else {
        result = originalGC();
      }

      if (isPromise(result)) {
        return result.then(() => {
          updateGCStats(start, gcType);
        });
      }

      updateGCStats(start, gcType);
      return result;
    } catch (error) {
      console.error(
        'GC error:',
        error instanceof Error ? error.message : String(error)
      );
      throw error;
    }
  };

  global.gc = wrappedGC as NodeJS.Global['gc'];
  gcRestore = () => {
    global.gc = originalGC;
    gcRestore = null;
  };

  return () => {
    gcRestore?.();
  };
}
