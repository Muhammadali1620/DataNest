// @ts-check
// Runs probe.cjs inside several editors and prints a summary (ROADMAP V0.12).
// Usage: node scripts/research/sqlite-probe/run.mjs <outDir> [target...]
//   target: "vscode@<version>" (downloaded) or "<label>=<path to editor executable>".
// Every editor gets its own user-data and extensions folders, so personal profiles
// and running windows are never touched.
import { runTests } from '@vscode/test-electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const [outDir, ...targets] = process.argv.slice(2);
if (!outDir || targets.length === 0) {
  console.error('Usage: run.mjs <outDir> vscode@1.105.0 cursor=/usr/share/cursor/cursor ...');
  process.exit(2);
}

// When started from a VS Code terminal, these would make editors start as plain Node.
for (const name of Object.keys(process.env)) {
  if (name.startsWith('ELECTRON_') || name.startsWith('VSCODE_')) {
    Reflect.deleteProperty(process.env, name);
  }
}

/** @type {Record<string, unknown>} */
const results = {};
for (const target of targets) {
  const [label, executable] = target.includes('=') ? target.split('=') : [target, undefined];
  if (!label) {
    continue;
  }
  const work = resolve(outDir, label.replace(/[^\w.@-]/g, '_'));
  mkdirSync(work, { recursive: true });
  const report = join(work, 'report.json');
  process.env.DATANEST_PROBE_OUT = report;
  try {
    await runTests({
      ...(executable
        ? { vscodeExecutablePath: executable }
        : { version: label.split('@')[1], cachePath: join(resolve(outDir), 'cache') }),
      extensionDevelopmentPath: root,
      extensionTestsPath: join(root, 'scripts/research/sqlite-probe/probe.cjs'),
      launchArgs: [
        '--disable-extensions',
        '--disable-workspace-trust',
        '--skip-welcome',
        `--user-data-dir=${join(work, 'user-data')}`,
        `--extensions-dir=${join(work, 'extensions')}`,
      ],
    });
    results[label] = JSON.parse(readFileSync(report, 'utf8'));
  } catch (error) {
    results[label] = { error: String(error) };
  }
}
const summary = join(resolve(outDir), 'summary.json');
writeFileSync(summary, JSON.stringify(results, null, 2));
console.log(`Summary: ${summary}`);
