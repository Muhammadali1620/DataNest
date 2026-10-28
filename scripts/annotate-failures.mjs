// @ts-check
// Runs a test command and, when it fails on CI, repeats the end of its output as one
// GitHub annotation. Job logs need a token to read, annotations do not, and they show
// up on the commit and the pull request: a red Windows-only job is then explained.
//
//   node scripts/annotate-failures.mjs <title> <command> [args…]

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/** Lines kept from the end of the output; an annotation is meant to be short. */
export const MAX_LINES = 80;

/**
 * The `::error` workflow command for a failed run: from mocha's "N failing" (or
 * vitest's "Failed Tests") to the end, else the last lines, colors stripped, and
 * escaped as GitHub expects (`%`, CR and LF).
 *
 * @param {string} title
 * @param {string} output
 * @returns {string}
 */
export function failureAnnotation(title, output) {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/gu, '');
  const lines = plain.split(/\r?\n/u);
  const start = lines.findIndex((line) => /^\s*\d+ failing\b|Failed Tests \d+/u.test(line));
  const tail = (start === -1 ? lines : lines.slice(start)).slice(-MAX_LINES).join('\n').trim();
  const escape = (/** @type {string} */ text) =>
    text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A');
  const property = (/** @type {string} */ text) =>
    escape(text).replaceAll(',', '%2C').replaceAll(':', '%3A');
  return `::error title=${property(title)}::${escape(tail === '' ? 'No output' : tail)}`;
}

async function main() {
  const [title, command, ...args] = process.argv.slice(2);
  if (title === undefined || command === undefined) {
    throw new Error('Usage: annotate-failures.mjs <title> <command> [args…]');
  }
  let output = '';
  const child = spawn(command, args, {
    shell: process.platform === 'win32',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', (/** @type {Buffer} */ chunk) => {
      output += chunk.toString();
      (stream === child.stdout ? process.stdout : process.stderr).write(chunk);
    });
  }
  /** @type {number} */
  const code = await new Promise((resolve) => {
    child.on('close', (/** @type {number | null} */ exit) => {
      resolve(exit ?? 1);
    });
  });
  if (code !== 0 && process.env.GITHUB_ACTIONS === 'true') {
    console.log(failureAnnotation(title, output));
  }
  process.exit(code);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  await main();
}
