// Integration tests come in groups, one per compose profile (V6.1): a group names the
// folders of its tests and the servers they need. CI runs every group in its own job
// with only its databases up; locally `npm run test:integration` runs `core` and any
// other group whose databases happen to be running.

import { createConnection } from 'node:net';
import { testDatabase, testSshServer } from './databases';

type Env = Readonly<Record<string, string | undefined>>;

export interface Endpoint {
  readonly name: string;
  readonly host: string;
  readonly port: number;
}

export interface IntegrationGroup {
  /** Runs even when nobody names it, so its databases must be up (`core`). */
  readonly always: boolean;
  /** Folders under test/integration whose tests belong to the group. */
  readonly folders: readonly string[];
  /** Servers that must accept connections before the group's tests start. */
  endpoints(env: Env): Endpoint[];
}

const DEFINITIONS = {
  core: {
    always: true,
    folders: ['drivers', 'docker'],
    endpoints: (env) => [
      ...(['mysql', 'mariadb', 'postgres'] as const).map((id) => {
        const db = testDatabase(id, env);
        return { name: id, host: db.host, port: db.port };
      }),
      { name: 'ssh', host: testSshServer(env).host, port: testSshServer(env).port },
    ],
  },
  mssql: {
    always: false,
    folders: ['mssql'],
    endpoints: (env) => {
      const db = testDatabase('mssql', env);
      return [{ name: 'mssql', host: db.host, port: db.port }];
    },
  },
  clickhouse: {
    always: false,
    folders: ['clickhouse'],
    endpoints: (env) => {
      const db = testDatabase('clickhouse', env);
      return [{ name: 'clickhouse', host: db.host, port: db.port }];
    },
  },
} as const satisfies Record<string, IntegrationGroup>;

export type IntegrationGroupId = keyof typeof DEFINITIONS;

// Typed by the interface, so code reads `always` instead of comparing ids.
export const INTEGRATION_GROUPS: Readonly<Record<IntegrationGroupId, IntegrationGroup>> =
  DEFINITIONS;

export const GROUP_IDS = Object.keys(DEFINITIONS) as IntegrationGroupId[];

/** Comma- or space-separated group ids, or `all`; unset runs what is up (see below). */
export const GROUPS_ENV = 'DATANEST_IT';

function isGroupId(value: string): value is IntegrationGroupId {
  return (GROUP_IDS as readonly string[]).includes(value);
}

/** The groups `DATANEST_IT` names, or undefined when it is unset or blank. */
export function parseGroups(env: Env = process.env): IntegrationGroupId[] | undefined {
  const names = (env[GROUPS_ENV] ?? '').split(/[\s,]+/u).filter((name) => name !== '');
  if (names.length === 0) {
    return undefined;
  }
  if (names.includes('all')) {
    return [...GROUP_IDS];
  }
  const unknown = names.filter((name) => !isGroupId(name));
  if (unknown.length > 0) {
    throw new Error(
      `${GROUPS_ENV} names unknown groups: ${unknown.join(', ')}; known: ${GROUP_IDS.join(', ')}, all`,
    );
  }
  return GROUP_IDS.filter((id) => names.includes(id));
}

export function canConnect({ host, port }: Endpoint): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port, timeout: 1000 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => {
      resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

export interface GroupSelection {
  readonly groups: IntegrationGroupId[];
  /** Groups left out because their databases are not running (only when unset). */
  readonly skipped: IntegrationGroupId[];
}

/**
 * What a run tests. Named groups are taken as they are, and the global setup insists
 * that their databases are up. Without a name, the `always` groups run (and must be up)
 * and every other group runs only if all its servers answer.
 */
export async function selectGroups(
  env: Env = process.env,
  reachable: (endpoint: Endpoint) => Promise<boolean> = canConnect,
): Promise<GroupSelection> {
  const named = parseGroups(env);
  if (named !== undefined) {
    return { groups: named, skipped: [] };
  }
  const groups: IntegrationGroupId[] = [];
  const skipped: IntegrationGroupId[] = [];
  for (const id of GROUP_IDS) {
    const group = INTEGRATION_GROUPS[id];
    const up =
      group.always || (await Promise.all(group.endpoints(env).map(reachable))).every(Boolean);
    (up ? groups : skipped).push(id);
  }
  return { groups, skipped };
}

/** Vitest `include` patterns of the groups. */
export function includePatterns(groups: readonly IntegrationGroupId[]): string[] {
  return groups.flatMap((id) =>
    INTEGRATION_GROUPS[id].folders.map((folder) => `test/integration/${folder}/**/*.int.test.ts`),
  );
}
