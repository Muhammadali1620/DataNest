import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_PORTS,
  PORT_ENV,
  resolvePort,
  testDatabase,
  type TestDatabaseId,
  testSshServer,
} from '../../helpers/databases';

const IDS: TestDatabaseId[] = ['mysql', 'mariadb', 'postgres', 'mssql', 'clickhouse', 'oracle'];

describe('test database settings', () => {
  it('uses distinct default ports in 7000-7999', () => {
    const ports = Object.values(DEFAULT_PORTS);
    expect(new Set(ports).size).toBe(ports.length);
    for (const port of ports) {
      expect(port).toBeGreaterThanOrEqual(7000);
      expect(port).toBeLessThanOrEqual(7999);
    }
  });

  it.each(IDS)('falls back to the default port for %s', (id) => {
    expect(resolvePort(id, {})).toBe(DEFAULT_PORTS[id]);
    expect(resolvePort(id, { [PORT_ENV[id]]: '' })).toBe(DEFAULT_PORTS[id]);
    expect(resolvePort(id, { [PORT_ENV[id]]: '   ' })).toBe(DEFAULT_PORTS[id]);
  });

  it('takes a port from the environment', () => {
    expect(resolvePort('mysql', { DATANEST_MYSQL_PORT: '7999' })).toBe(7999);
    expect(resolvePort('postgres', { DATANEST_POSTGRES_PORT: ' 7000 ' })).toBe(7000);
  });

  it('ignores env vars of other databases', () => {
    expect(resolvePort('mariadb', { DATANEST_MYSQL_PORT: '7111' })).toBe(DEFAULT_PORTS.mariadb);
  });

  it.each([['6999'], ['8000'], ['3306'], ['5432'], ['0']])(
    'rejects the port %s outside 7000-7999',
    (port) => {
      expect(() => resolvePort('mysql', { DATANEST_MYSQL_PORT: port })).toThrow(
        'DATANEST_MYSQL_PORT must be within 7000-7999',
      );
    },
  );

  it.each([['abc'], ['7306abc'], ['-7306'], ['7306.5'], ['1e4']])(
    'rejects the non-numeric port %j',
    (port) => {
      expect(() => resolvePort('postgres', { DATANEST_POSTGRES_PORT: port })).toThrow(
        'DATANEST_POSTGRES_PORT must be a number',
      );
    },
  );

  it('connects to localhost with the seed credentials', () => {
    expect(testDatabase('mariadb', {})).toEqual({
      id: 'mariadb',
      host: '127.0.0.1',
      port: 7307,
      user: 'datanest',
      password: 'datanest',
      database: 'datanest_test',
      emptyDatabase: 'datanest_empty',
    });
  });
});

describe('test SSH server settings', () => {
  it('defaults to port 7022 with the test user and key', () => {
    const ssh = testSshServer({});
    expect(ssh).toMatchObject({ host: '127.0.0.1', port: 7022, user: 'datanest' });
    expect(existsSync(ssh.keyFile)).toBe(true);
    expect(ssh.targets.postgres).toEqual({ host: 'postgres', port: 5432 });
  });

  it('takes a port from the environment, within 7000-7999 only', () => {
    expect(testSshServer({ DATANEST_SSH_PORT: '7122' }).port).toBe(7122);
    expect(() => testSshServer({ DATANEST_SSH_PORT: '22' })).toThrow('7000-7999');
    expect(() => testSshServer({ DATANEST_SSH_PORT: 'x' })).toThrow('7000-7999');
  });
});
