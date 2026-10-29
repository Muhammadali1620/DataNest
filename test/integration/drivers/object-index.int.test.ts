// The global object search reads every object of the real servers' seed: tables,
// views, routines, sequences and events, in every database the user can see.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { driver as clickhouseDriver } from '../../../src/drivers/clickhouse';
import { driver as oracleDriver } from '../../../src/drivers/oracle';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { browseSession } from '../../../src/services/browse-session';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { type IndexedObject, indexConnection } from '../../../src/services/object-index';
import type { ConnectionInput, DriverId } from '../../../src/shared/connection';
import { testDatabase } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let drivers: Record<DriverId, Driver>;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  drivers = {
    mysql: mysqlDriver,
    postgres: postgresDriver,
    sqlite: createSqliteDriver({ workerPath: worker.workerPath }),
    mssql: mssqlDriver,
    clickhouse: clickhouseDriver,
    oracle: oracleDriver,
  };
}, 60_000);

afterAll(() => {
  worker.dispose();
});

async function search(input: ConnectionInput, password?: string) {
  const logger = new RecordingLogger();
  const store = new ConnectionStore({
    state: new FakeMemento(),
    secrets: new FakeSecretStorage(),
    logger,
  });
  const manager = new ConnectionManager({
    store,
    drivers: { get: (id) => Promise.resolve(drivers[id]) },
    logger,
  });
  const cache = new MetadataCache({ logger });
  const id = (await store.add(input, password)).id;
  return {
    manager,
    id,
    found: async () =>
      await indexConnection({ manager, store, cache, showSystemObjects: () => false }, id),
  };
}

function names(found: readonly IndexedObject[], kind: IndexedObject['kind']): string[] {
  return found
    .filter((o) => o.kind === kind)
    .map((o) => `${o.database ?? ''}/${o.schema ?? ''}/${o.name}`);
}

describe.each(['mysql', 'mariadb'] as const)('object search on %s', (serverId) => {
  it('finds tables, views and routines of every user database, not the system ones', async () => {
    const db = testDatabase(serverId);
    const s = await search(
      {
        name: serverId,
        driver: 'mysql',
        host: db.host,
        port: db.port,
        user: db.user,
      },
      db.password,
    );
    try {
      const found = await s.found();
      expect(names(found, 'table')).toContain('datanest_test//orders');
      expect(names(found, 'view')).toContain('datanest_test//order_totals');
      expect(names(found, 'function')).toEqual(['datanest_test//order_total']);
      expect(names(found, 'procedure')).toEqual(['datanest_test//customer_orders']);
      expect(found.some((o) => o.database === 'information_schema')).toBe(false);
    } finally {
      await s.manager.disconnect(s.id);
    }
  });
});

describe('object search on postgres', () => {
  it('finds objects of every schema of the connection database', async () => {
    const db = testDatabase('postgres');
    const s = await search(
      {
        name: 'pg',
        driver: 'postgres',
        host: db.host,
        port: db.port,
        user: db.user,
        database: db.database,
      },
      db.password,
    );
    try {
      const found = await s.found();
      expect(names(found, 'table')).toEqual(
        expect.arrayContaining([
          'datanest_test/public/orders',
          'datanest_test/inventory/warehouses',
        ]),
      );
      expect(found.find((o) => o.name === 'product_sales')).toMatchObject({
        kind: 'view',
        materialized: true,
      });
      expect(found.find((o) => o.name === 'order_total')).toMatchObject({
        kind: 'function',
        signature: 'p_order_id integer',
      });
      expect(names(found, 'sequence')).toContain('datanest_test/public/invoice_number_seq');
      expect(found.some((o) => o.schema === 'pg_catalog')).toBe(false);
    } finally {
      await s.manager.disconnect(s.id);
    }
  });
});

describe('object search on sqlite', () => {
  it('finds the tables and views of a file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'datanest-index-'));
    const s = await search({
      name: 'f',
      driver: 'sqlite',
      file: join(dir, 'f.db'),
    });
    try {
      const session = await browseSession(s.manager, s.id);
      await runAll(session, 'CREATE TABLE notes (id INTEGER PRIMARY KEY)');
      await runAll(session, 'CREATE VIEW note_ids AS SELECT id FROM notes');
      expect((await s.found()).map((o) => `${o.kind}:${o.name}`)).toEqual([
        'view:note_ids',
        'table:notes',
      ]);
    } finally {
      await s.manager.disconnect(s.id);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
