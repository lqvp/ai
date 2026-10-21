import { readdirSync, readFileSync, statSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};
const declared = {
  ...pkg.dependencies,
  ...pkg.devDependencies,
};

const builtins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];

  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full));
    } else if (entry.endsWith('.ts')) {
      files.push(full);
    }
  }

  return files;
}

function packageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    return specifier.split('/').slice(0, 2).join('/');
  }
  return specifier.split('/')[0];
}

/** src/** の import から、外部パッケージ名を集める */
function collectImports(): Map<string, string[]> {
  const imports = new Map<string, string[]>();

  for (const file of listTsFiles(join(root, 'src'))) {
    const source = readFileSync(file, 'utf8');
    const pattern = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (
        specifier.startsWith('.') ||
        specifier.startsWith('/') ||
        specifier.startsWith('@/') ||
        builtins.has(specifier)
      ) {
        continue;
      }

      const name = packageName(specifier);
      const files = imports.get(name) ?? [];
      if (!files.includes(file)) files.push(file);
      imports.set(name, files);
    }
  }

  return imports;
}

describe('dependencies', () => {
  it('declares every package imported from src', () => {
    const missing = [...collectImports()]
      .filter(([name]) => !(name in declared))
      .map(([name, files]) => `${name} (${files.join(', ')})`);

    expect(missing).toEqual([]);
  });

  it('keeps the lockfile importer in sync with package.json', () => {
    const lockfile = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8');
    const importer = lockfile.split('\nimporters:')[1]?.split('\npackages:')[0];

    expect(importer).toBeDefined();

    // package.json の依存はすべてロックファイルに載っている
    for (const [name, version] of Object.entries(pkg.dependencies)) {
      const escaped = name.replace(/[/@.]/g, (c) => `\\${c}`);
      const entry = new RegExp(
        `^\\s+'?${escaped}'?:\\n\\s+specifier: ${version.replace(/\./g, '\\.')}\\n\\s+version: `,
        'm'
      );

      expect(importer).toMatch(entry);
    }

    // 逆方向: ロックファイルにだけ残っている依存がない
    const runtimeSection = importer
      ?.split(/^ {4}dependencies:$/m)[1]
      ?.split(/^ {4}devDependencies:$/m)[0];
    const locked = [
      ...(runtimeSection ?? '').matchAll(/^ {6}'?([^':\n]+)'?:$/gm),
    ].map((match) => match[1]);

    expect(locked.sort()).toEqual(Object.keys(pkg.dependencies).sort());
  });

  it('does not declare packages that were intentionally removed', () => {
    for (const removed of [
      'axios',
      'node-cron',
      'dayjs',
      'uuid',
      'memory-streams',
      'formdata-node',
      'days',
      'misskey-reversi',
    ]) {
      expect(declared).not.toHaveProperty(removed);
    }
  });
});
