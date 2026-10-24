import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createTempDir, readJson, ROOT } from '../../helpers/repo';

interface LaunchConfig {
  name: string;
  type: string;
  request: string;
  args: string[];
  outFiles: string[];
  preLaunchTask?: string;
}

interface Pattern {
  regexp: string;
  message?: number;
  file?: number;
  line?: number;
  column?: number;
}

interface Task {
  label: string;
  type: string;
  script?: string;
  isBackground?: boolean;
  problemMatcher:
    | string[]
    | {
        pattern: Pattern[];
        background: { activeBegin: boolean; beginsPattern: string; endsPattern: string };
      };
}

const launch = readJson('.vscode/launch.json') as { configurations: LaunchConfig[] };
const { tasks } = readJson('.vscode/tasks.json') as { tasks: Task[] };
const { scripts } = readJson('package.json') as { scripts: Record<string, string> };

function task(label: string): Task {
  const found = tasks.find((t) => t.label === label);
  if (!found) {
    throw new Error(`No task "${label}"`);
  }
  return found;
}

type InlineMatcher = Exclude<Task['problemMatcher'], string[]>;

function inlineMatcher(t: Task): InlineMatcher {
  if (Array.isArray(t.problemMatcher)) {
    throw new Error(`Task "${t.label}" needs an inline problem matcher`);
  }
  return t.problemMatcher;
}

const watchTask = task('watch');
const matcher = inlineMatcher(watchTask);

/** Same idea as VS Code: strip ANSI codes, then match the multi-line pattern line by line. */
function findProblems(
  output: string,
): { message: string; file: string; line: number; column: number }[] {
  // eslint-disable-next-line no-control-regex
  const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
  const patterns = matcher.pattern.map((p) => ({ ...p, re: new RegExp(p.regexp) }));
  const problems = [];
  for (let i = 0; i + patterns.length <= lines.length; i++) {
    const matches = patterns.map((p, k) => p.re.exec(lines[i + k] ?? ''));
    if (matches.every(Boolean)) {
      const get = (key: 'message' | 'file' | 'line' | 'column'): string => {
        const index = patterns.findIndex((p) => p[key] !== undefined);
        const group = patterns[index]?.[key];
        return group === undefined ? '' : (matches[index]?.[group] ?? '');
      };
      problems.push({
        message: get('message'),
        file: get('file'),
        line: Number(get('line')),
        column: Number(get('column')),
      });
    }
  }
  return problems;
}

/**
 * Runs the real host build in watch mode on a broken file, edits it once, and returns
 * everything esbuild printed: an initial build and one rebuild.
 */
function runWatch(rootDir: string, color: boolean): Promise<string> {
  const config = pathToFileURL(join(ROOT, 'scripts/build-config.mjs')).href;
  const esbuild = pathToFileURL(join(ROOT, 'node_modules/esbuild/lib/main.js')).href;
  const code = `
    const { context } = await import(${JSON.stringify(esbuild)});
    const { createHostBuildOptions } = await import(${JSON.stringify(config)});
    const ctx = await context({ ...createHostBuildOptions({ rootDir: process.cwd() }), color: ${String(color)} });
    await ctx.watch();
    process.stdin.on('data', async () => { await ctx.dispose(); process.exit(0); });
  `;
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: rootDir });
    let output = '';
    let finished = 0;
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`esbuild watch timed out:\n${output}`));
    }, 15_000);
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const count = output.split('[watch] build finished').length - 1;
      if (count > finished) {
        finished = count;
        if (finished === 1) {
          // Trigger a rebuild, which prints "build started".
          writeFileSync(join(rootDir, 'src/extension.ts'), 'export const b = ;\n');
        } else {
          child.stdin.write('stop');
        }
      }
    });
    child.on('error', reject);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

describe('.vscode/launch.json', () => {
  it('has extension host configurations', () => {
    expect(launch.configurations.length).toBeGreaterThan(0);
    for (const config of launch.configurations) {
      expect(config.type).toBe('extensionHost');
      expect(config.request).toBe('launch');
      expect(config.args).toContain('--extensionDevelopmentPath=${workspaceFolder}');
    }
  });

  it('maps breakpoints to the built bundles', () => {
    for (const config of launch.configurations) {
      expect(config.outFiles).toEqual(['${workspaceFolder}/dist/**/*.js']);
    }
  });

  it('starts the watch build before launching', () => {
    for (const config of launch.configurations) {
      expect(config.preLaunchTask).toBe('watch');
    }
  });
});

describe('.vscode/tasks.json', () => {
  it('runs only npm scripts that exist', () => {
    for (const t of tasks) {
      expect(t.type).toBe('npm');
      expect(Object.keys(scripts)).toContain(t.script);
    }
  });

  it('has unique labels', () => {
    const labels = tasks.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
  });

  it('runs the watch build in the background', () => {
    expect(watchTask.script).toBe('watch');
    expect(scripts.watch).toBe('node scripts/build.mjs --watch');
    expect(watchTask.isBackground).toBe(true);
    // The first watch build prints no "build started" line.
    expect(matcher.background.activeBegin).toBe(true);
  });

  describe('watch problem matcher on real esbuild output', () => {
    let tmp: ReturnType<typeof createTempDir>;

    beforeEach(() => {
      tmp = createTempDir();
      mkdirSync(join(tmp.path, 'src'), { recursive: true });
      writeFileSync(join(tmp.path, 'src/extension.ts'), 'export const a = ;\n');
    });

    afterEach(() => {
      tmp.dispose();
    });

    it.each([
      ['plain', false],
      ['colored (task terminal)', true],
    ])(
      'finds errors and build boundaries in %s output',
      async (_name, color) => {
        const output = await runWatch(tmp.path, color);
        // eslint-disable-next-line no-control-regex
        const lines = output.replace(/\u001b\[[0-9;]*m/g, '').split(/\r?\n/);
        const begins = new RegExp(matcher.background.beginsPattern);
        const ends = new RegExp(matcher.background.endsPattern);

        expect(lines.filter((line) => ends.test(line))).toHaveLength(2);
        expect(lines.filter((line) => begins.test(line))).toHaveLength(1);
        expect(findProblems(output)).toEqual([
          { message: 'Unexpected ";"', file: 'src/extension.ts', line: 1, column: 17 },
          { message: 'Unexpected ";"', file: 'src/extension.ts', line: 1, column: 17 },
        ]);
      },
      30_000,
    );

    it('reports nothing for a clean build', () => {
      expect(findProblems('[watch] build finished, watching for changes...\n')).toEqual([]);
    });
  });
});
