// The version and sizes the tree writes after names (V11.14), against real servers.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { readServerVersion, readSizeBytes } from '../../../src/services/server-labels';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';

function config(id: 'postgres' | 'mysql'): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `labels-${id}`,
    name: 'labels',
    driver: id,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

/** A manager that hands out one session, which is all the readers use. */
function managerOf(driver: Driver, session: Session) {
  return {
    acquire: () => Promise.resolve(session),
    driverOf: () => Promise.resolve(driver),
  } as never;
}

describe.each([
  ['postgres', postgresDriver],
  ['mysql', mysqlDriver],
] as const)('%s labels', (id, driver) => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config(id));
  });

  afterAll(async () => {
    await session.close();
  });

  it('reads a version that starts with a number', async () => {
    const version = await readServerVersion(managerOf(driver, session), 'c1', id);
    expect(version).toMatch(/^\d+(\.\d+)+$/);
  });

  it('adds up the size of the database or schema the data lives in', async () => {
    const manager = managerOf(driver, session);
    const db = testDatabase(id).database;
    const size =
      id === 'postgres'
        ? await readSizeBytes(manager, 'c1', id, { database: db, schema: 'public' })
        : await readSizeBytes(manager, 'c1', id, { database: db });
    expect(size).toBeGreaterThan(0);
  });

  it('reads the whole database too, where the server has such a number', async () => {
    if (id === 'postgres') {
      const whole = await readSizeBytes(managerOf(driver, session), 'c1', id, {
        database: testDatabase(id).database,
      });
      expect(whole).toBeGreaterThan(0);
    }
  });

  it('has a size of nothing for a schema that is not there', async () => {
    const manager = managerOf(driver, session);
    const size = await readSizeBytes(manager, 'c1', id, { database: 'nope', schema: 'nope' });
    expect(size === undefined || size === 0).toBe(true);
    await runAll(session, 'SELECT 1');
  });
});
