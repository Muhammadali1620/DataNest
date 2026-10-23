import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Absolute path of the project root. */
export const ROOT = fileURLToPath(new URL('../..', import.meta.url));

/** Generated or third-party folders that never contain project files. */
export const IGNORED_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  'dist',
  'out',
  'coverage',
  '.git',
  '.vscode-test',
]);

export function readJson(path: string): unknown {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

/** Lists files under `dir` (relative to ROOT) as POSIX paths relative to ROOT. */
export function listFiles(dir: string): string[] {
  const result: string[] = [];
  const walk = (abs: string): void => {
    let entries;
    try {
      entries = readdirSync(abs, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw error;
    }
    for (const entry of entries) {
      const child = join(abs, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRS.has(entry.name)) {
          walk(child);
        }
      } else {
        result.push(relative(ROOT, child).split(sep).join('/'));
      }
    }
  };
  walk(join(ROOT, dir));
  return result.sort();
}

/** Creates a temp directory; call the returned `dispose` in afterEach. */
export function createTempDir(prefix = 'datanest-test-'): { path: string; dispose: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return {
    path,
    dispose: () => {
      rmSync(path, { recursive: true, force: true });
    },
  };
}
