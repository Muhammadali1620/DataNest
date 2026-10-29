import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeGroups } from '../../../scripts/db.mjs';
import {
  type Endpoint,
  GROUP_IDS,
  GROUPS_ENV,
  includePatterns,
  INTEGRATION_GROUPS,
  parseGroups,
  selectGroups,
} from '../../helpers/integration-groups';
import { ROOT } from '../../helpers/repo';

const up = (): Promise<boolean> => Promise.resolve(true);

describe('integration groups (V6.1)', () => {
  it('has a group for every compose profile and nothing else', () => {
    const profiles = composeGroups(readFileSync(join(ROOT, 'docker/compose.yml'), 'utf8'));
    expect([...GROUP_IDS].sort()).toEqual([...profiles].sort());
  });

  it('puts every folder of integration tests in exactly one group', () => {
    const folders = readdirSync(join(ROOT, 'test/integration'), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    const claimed = GROUP_IDS.flatMap((id) => INTEGRATION_GROUPS[id].folders);
    expect([...claimed].sort()).toEqual(folders);
  });

  it.each(GROUP_IDS)('names folders of %s that exist', (id) => {
    for (const folder of INTEGRATION_GROUPS[id].folders) {
      expect(existsSync(join(ROOT, 'test/integration', folder))).toBe(true);
    }
  });

  it('checks MySQL, MariaDB, PostgreSQL and SSH for core, with port overrides', () => {
    const endpoints = INTEGRATION_GROUPS.core.endpoints({ DATANEST_POSTGRES_PORT: '7999' });
    expect(endpoints.map((e) => `${e.name}:${e.port}`)).toEqual([
      'mysql:7306',
      'mariadb:7307',
      'postgres:7999',
      'ssh:7022',
    ]);
    expect(new Set(endpoints.map((e) => e.host))).toEqual(new Set(['127.0.0.1']));
  });

  it('checks only SQL Server for mssql, which does not run unless it is up', () => {
    expect(INTEGRATION_GROUPS.mssql.always).toBe(false);
    expect(INTEGRATION_GROUPS.mssql.endpoints({})).toEqual([
      { name: 'mssql', host: '127.0.0.1', port: 7143 },
    ]);
  });

  it('turns groups into include patterns', () => {
    expect(includePatterns(['core'])).toEqual([
      'test/integration/drivers/**/*.int.test.ts',
      'test/integration/docker/**/*.int.test.ts',
    ]);
    expect(includePatterns([])).toEqual([]);
  });
});

describe('parseGroups', () => {
  it('is undefined when the variable is unset or blank', () => {
    expect(parseGroups({})).toBeUndefined();
    expect(parseGroups({ [GROUPS_ENV]: ' , ' })).toBeUndefined();
  });

  it('reads comma- and space-separated ids in group order, once each', () => {
    expect(parseGroups({ [GROUPS_ENV]: 'core, core core' })).toEqual(['core']);
  });

  it('expands all to every group', () => {
    expect(parseGroups({ [GROUPS_ENV]: 'all' })).toEqual(GROUP_IDS);
  });

  it('refuses unknown ids and lists the known ones', () => {
    expect(() => parseGroups({ [GROUPS_ENV]: 'core,db2' })).toThrow(
      `${GROUPS_ENV} names unknown groups: db2; known: ${GROUP_IDS.join(', ')}, all`,
    );
  });
});

describe('selectGroups', () => {
  it('takes named groups as they are, without probing anything', async () => {
    const probed: Endpoint[] = [];
    const selection = await selectGroups({ [GROUPS_ENV]: 'core' }, (endpoint) => {
      probed.push(endpoint);
      return Promise.resolve(false);
    });
    expect(selection).toEqual({ groups: ['core'], skipped: [] });
    expect(probed).toEqual([]);
  });

  it('always runs core when nothing is named, even if it is down', async () => {
    expect(INTEGRATION_GROUPS.core.always).toBe(true);
    const selection = await selectGroups({}, () => Promise.resolve(false));
    expect(selection.groups[0]).toBe('core');
    expect(selection.groups).toHaveLength(1);
    expect(selection.skipped).toEqual(GROUP_IDS.filter((id) => !INTEGRATION_GROUPS[id].always));
  });

  it('leaves out a group whose server does not answer', async () => {
    const selection = await selectGroups({}, (endpoint) =>
      Promise.resolve(endpoint.name !== 'mssql'),
    );
    expect(selection.groups).not.toContain('mssql');
    expect(selection.skipped).toContain('mssql');
  });

  it('adds every other group whose servers all answer', async () => {
    const selection = await selectGroups({}, up);
    expect(selection).toEqual({ groups: GROUP_IDS, skipped: [] });
  });
});
