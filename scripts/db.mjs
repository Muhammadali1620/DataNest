// @ts-check
// Starts and stops the test databases of docker/compose.yml by group (V6.1). Every
// service belongs to one compose profile, its group: `core` (MySQL, MariaDB, PostgreSQL
// and the SSH servers) and one per further DBMS. A CI job or a laptop then runs only
// the databases it tests; commands never reach beyond the `datanest` project (D17).
//
//   node scripts/db.mjs up [group…|all]      default: core
//   node scripts/db.mjs down                 every group
//   node scripts/db.mjs reset [group…|all]
//   node scripts/db.mjs logs [group…|all]

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';

export const COMPOSE_FILE = 'docker/compose.yml';

/** What `up` starts when no group is named: the databases most tests use. */
export const DEFAULT_GROUPS = ['core'];

export const ACTIONS = ['up', 'down', 'reset', 'logs'];

/**
 * The profiles of the compose file, in file order.
 *
 * @param {string} text compose YAML
 * @returns {string[]}
 */
export function composeGroups(text) {
  /** @type {{ services?: Record<string, { profiles?: string[] }> }} */
  const compose = /** @type {unknown} */ (parse(text)) ?? {};
  /** @type {string[]} */
  const groups = [];
  for (const service of Object.values(compose.services ?? {})) {
    for (const profile of service.profiles ?? []) {
      if (!groups.includes(profile)) {
        groups.push(profile);
      }
    }
  }
  return groups;
}

/**
 * `--profile` arguments for the named groups; `all` is every one of them.
 *
 * @param {readonly string[]} names
 * @param {readonly string[]} known
 * @returns {string[]}
 */
export function profileArgs(names, known) {
  const groups = names.length === 0 ? DEFAULT_GROUPS : names;
  if (groups.includes('all')) {
    return ['--profile', '*'];
  }
  const unknown = groups.filter((group) => !known.includes(group));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown database group ${unknown.map((g) => `"${g}"`).join(', ')}; ` +
        `known: ${known.join(', ')}, all`,
    );
  }
  return [...new Set(groups)].flatMap((group) => ['--profile', group]);
}

/**
 * The `docker` invocations for an action, in order.
 *
 * @param {string} action
 * @param {readonly string[]} names
 * @param {readonly string[]} known
 * @returns {string[][]}
 */
export function dockerCommands(action, names, known) {
  const base = ['compose', '-f', COMPOSE_FILE];
  // Down takes every profile: a group started earlier must not keep running.
  const down = [...base, '--profile', '*', 'down', '--volumes'];
  switch (action) {
    case 'up':
      return [[...base, ...profileArgs(names, known), 'up', '-d', '--wait']];
    case 'down':
      if (names.length > 0) {
        throw new Error('down stops every group; it takes no group names');
      }
      return [down];
    case 'reset':
      return [down, [...base, ...profileArgs(names, known), 'up', '-d', '--wait']];
    case 'logs':
      return [[...base, ...profileArgs(names, known), 'logs', '-f']];
    default:
      throw new Error(`Usage: db.mjs ${ACTIONS.join('|')} [group…|all]`);
  }
}

function main() {
  const [action = '', ...names] = process.argv.slice(2);
  const root = join(fileURLToPath(import.meta.url), '..', '..');
  const known = composeGroups(readFileSync(join(root, COMPOSE_FILE), 'utf8'));
  for (const args of dockerCommands(action, names, known)) {
    const result = spawnSync('docker', args, { cwd: root, stdio: 'inherit' });
    if (result.error !== undefined) {
      throw result.error;
    }
    if (result.status !== 0) {
      process.exit(result.status ?? 1);
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
