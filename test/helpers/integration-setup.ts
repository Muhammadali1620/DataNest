import {
  canConnect,
  GROUP_IDS,
  INTEGRATION_GROUPS,
  type IntegrationGroupId,
  parseGroups,
} from './integration-groups';

/**
 * Vitest global setup: fail fast with a clear hint when a database of the groups this
 * run tests is not running. The config has already written the groups to
 * `DATANEST_IT`; without it, the groups that always run are checked.
 */
export async function setup(): Promise<void> {
  const groups = parseGroups() ?? GROUP_IDS.filter((id) => INTEGRATION_GROUPS[id].always);
  const down: string[] = [];
  const downGroups = new Set<IntegrationGroupId>();
  for (const id of GROUP_IDS.filter((group) => groups.includes(group))) {
    for (const endpoint of INTEGRATION_GROUPS[id].endpoints(process.env)) {
      if (!(await canConnect(endpoint))) {
        down.push(`${endpoint.name} (${endpoint.host}:${endpoint.port})`);
        downGroups.add(id);
      }
    }
  }
  if (down.length > 0) {
    // `db:up` alone starts the groups that always run; any other has to be named.
    const start = [...downGroups].every((id) => INTEGRATION_GROUPS[id].always)
      ? 'npm run db:up'
      : `npm run db:up -- ${[...downGroups].join(' ')}`;
    const error = new Error(
      `Test databases are not reachable: ${down.join(', ')}. Run "${start}".`,
    );
    // Vitest crashes while source-mapping stack frames of global setup errors,
    // which hides this message; a frameless stack avoids that.
    error.stack = `Error: ${error.message}`;
    throw error;
  }
}
