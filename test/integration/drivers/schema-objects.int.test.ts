// Routines, triggers, sequences, events and indexes as the tree lists them,
// read from the real servers and their seed (docker/seed).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

function serverConfig(id: TestDatabaseId, driver: DriverId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `objects-${id}`,
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

describe.each(['mysql', 'mariadb'] as const)('schema objects on %s', (serverId) => {
  let session: Session;
  const database = testDatabase(serverId).database;

  beforeAll(async () => {
    session = await mysqlDriver.openSession(serverConfig(serverId, 'mysql'));
    await runAll(session, 'DROP EVENT IF EXISTS objects_event');
    await runAll(session, 'DROP TABLE IF EXISTS objects_idx');
  });

  afterAll(async () => {
    await runAll(session, 'DROP EVENT IF EXISTS objects_event');
    await runAll(session, 'DROP TABLE IF EXISTS objects_idx');
    if (serverId === 'mariadb') {
      await runAll(session, 'DROP SEQUENCE IF EXISTS objects_seq');
    }
    await session.close();
  });

  it('lists functions and procedures apart', async () => {
    expect(await session.metadata.listObjects({ database }, 'function')).toEqual([
      { name: 'order_total', kind: 'function' },
    ]);
    expect(await session.metadata.listObjects({ database }, 'procedure')).toEqual([
      { name: 'customer_orders', kind: 'procedure' },
    ]);
  });

  it('lists triggers with their tables', async () => {
    expect(await session.metadata.listObjects({ database }, 'trigger')).toEqual([
      { name: 'order_items_quantity_check', kind: 'trigger', table: 'order_items' },
    ]);
  });

  it('lists events, and nothing in a database without them', async () => {
    await runAll(
      session,
      'CREATE EVENT objects_event ON SCHEDULE EVERY 1 HOUR DISABLE DO SELECT 1',
    );
    expect(await session.metadata.listObjects({ database }, 'event')).toEqual([
      { name: 'objects_event', kind: 'event' },
    ]);
    const empty = testDatabase(serverId).emptyDatabase;
    expect(await session.metadata.listObjects({ database: empty }, 'event')).toEqual([]);
    expect(await session.metadata.listObjects({ database: empty }, 'function')).toEqual([]);
  });

  it('lists the indexes of a table, the primary key first', async () => {
    expect(await session.metadata.listIndexes({ database, name: 'products' })).toEqual([
      { name: 'PRIMARY', columns: ['id'], unique: true, primary: true, method: 'BTREE' },
      {
        name: 'ix_products_name',
        columns: ['name'],
        unique: false,
        primary: false,
        method: 'BTREE',
      },
      { name: 'uq_products_sku', columns: ['sku'], unique: true, primary: false, method: 'BTREE' },
    ]);
  });

  it('keeps the order of a composite key and shows fulltext indexes', async () => {
    await runAll(
      session,
      `CREATE TABLE objects_idx (
         a INT NOT NULL, b INT NOT NULL, body TEXT,
         PRIMARY KEY (b, a),
         FULLTEXT KEY ft_body (body)
       )`,
    );
    const indexes = await session.metadata.listIndexes({ database, name: 'objects_idx' });
    expect(indexes[0]).toEqual({
      name: 'PRIMARY',
      columns: ['b', 'a'],
      unique: true,
      primary: true,
      method: 'BTREE',
    });
    expect(indexes[1]).toMatchObject({ name: 'ft_body', columns: ['body'], method: 'FULLTEXT' });
  });

  it('has nothing for a table that does not exist', async () => {
    expect(await session.metadata.listIndexes({ database, name: 'no_such_table' })).toEqual([]);
  });

  it('lists MariaDB sequences as sequences, not as tables', async () => {
    if (serverId === 'mysql') {
      // MySQL has no sequences: the list is empty rather than an error.
      expect(await session.metadata.listObjects({ database }, 'sequence')).toEqual([]);
      return;
    }
    await runAll(session, 'CREATE SEQUENCE objects_seq START WITH 5');
    expect(await session.metadata.listObjects({ database }, 'sequence')).toEqual([
      { name: 'objects_seq', kind: 'sequence' },
    ]);
    const tables = await session.metadata.listTables({ database });
    expect(tables.map((table) => table.name)).not.toContain('objects_seq');
  });
});

describe('schema objects on postgres', () => {
  let session: Session;

  beforeAll(async () => {
    session = await postgresDriver.openSession(serverConfig('postgres', 'postgres'));
    await runAll(session, 'DROP TABLE IF EXISTS objects_idx');
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS objects_idx');
    await session.close();
  });

  it('lists functions with their signatures, procedures apart', async () => {
    // Procedures keep argument modes in their identity, as PostgreSQL prints it.
    expect(await session.metadata.listObjects({ schema: 'public' }, 'function')).toEqual([
      { name: 'order_items_quantity_check', kind: 'function', signature: '' },
      { name: 'order_total', kind: 'function', signature: 'p_order_id integer' },
    ]);
    expect(await session.metadata.listObjects({}, 'procedure')).toEqual([
      {
        name: 'restock',
        kind: 'procedure',
        signature: 'IN p_product_id integer, IN p_amount integer',
      },
    ]);
  });

  it('lists triggers with their tables, without the internal ones behind foreign keys', async () => {
    expect(await session.metadata.listObjects({}, 'trigger')).toEqual([
      { name: 'order_items_quantity_check', kind: 'trigger', table: 'order_items' },
    ]);
  });

  it('lists sequences, but not the ones behind identity columns', async () => {
    await runAll(
      session,
      'CREATE TABLE objects_idx (id integer GENERATED ALWAYS AS IDENTITY, a int, b text, c int)',
    );
    const names = (await session.metadata.listObjects({}, 'sequence')).map((s) => s.name);
    expect(names).toContain('invoice_number_seq');
    expect(names).toContain('customers_id_seq');
    expect(names.some((name) => name.startsWith('objects_idx'))).toBe(false);
    expect(await session.metadata.listObjects({ schema: 'inventory' }, 'sequence')).toEqual([
      { name: 'warehouses_id_seq', kind: 'sequence' },
    ]);
  });

  it('reads a routine back by the signature it was listed with', async () => {
    for (const kind of ['function', 'procedure'] as const) {
      for (const object of await session.metadata.listObjects({}, kind)) {
        const statements = await session.metadata.getDefinition({ ...object, kind });
        expect(statements[0]).toContain(object.name);
      }
    }
  });

  it('has no events', async () => {
    expect(await session.metadata.listObjects({}, 'event')).toEqual([]);
  });

  it('lists indexes with method, expressions and partial conditions', async () => {
    expect(await session.metadata.listIndexes({ name: 'products' })).toEqual([
      { name: 'products_pkey', columns: ['id'], unique: true, primary: true, method: 'btree' },
      {
        name: 'ix_products_name',
        columns: ['name'],
        unique: false,
        primary: false,
        method: 'btree',
      },
      { name: 'products_sku_key', columns: ['sku'], unique: true, primary: false, method: 'btree' },
    ]);
    await runAll(session, 'CREATE INDEX objects_expr ON objects_idx (lower(b), a)');
    await runAll(session, 'CREATE UNIQUE INDEX objects_part ON objects_idx (a) WHERE c > 0');
    await runAll(session, 'CREATE INDEX objects_hash ON objects_idx USING hash (b)');
    await runAll(session, 'CREATE INDEX objects_incl ON objects_idx (a) INCLUDE (c)');
    expect(await session.metadata.listIndexes({ schema: 'public', name: 'objects_idx' })).toEqual([
      {
        name: 'objects_expr',
        columns: ['lower(b)', 'a'],
        unique: false,
        primary: false,
        method: 'btree',
      },
      { name: 'objects_hash', columns: ['b'], unique: false, primary: false, method: 'hash' },
      // INCLUDE columns are carried along, not part of the key.
      { name: 'objects_incl', columns: ['a'], unique: false, primary: false, method: 'btree' },
      {
        name: 'objects_part',
        columns: ['a'],
        unique: true,
        primary: false,
        method: 'btree',
        where: 'c > 0',
      },
    ]);
  });

  it('reads indexes of another schema', async () => {
    const indexes = await session.metadata.listIndexes({
      schema: 'inventory',
      name: 'stock_levels',
    });
    expect(indexes[0]).toMatchObject({
      columns: ['warehouse_id', 'product_id'],
      primary: true,
    });
  });
});

describe('schema objects on sqlite', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let dir: string;
  let session: Session;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-objects-'));
    session = await driver.openSession({
      id: 'objects-sqlite',
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'objects.db'),
    });
    for (const sql of [
      'CREATE TABLE plain (id INTEGER PRIMARY KEY, code TEXT UNIQUE, a INT, b INT)',
      'CREATE TABLE pair (x INT, y INT, PRIMARY KEY (y, x)) WITHOUT ROWID',
      'CREATE INDEX ix_plain_ab ON plain (b, a)',
      'CREATE INDEX ix_plain_expr ON plain (lower(code))',
      'CREATE TRIGGER plain_audit AFTER INSERT ON plain BEGIN SELECT 1; END',
      'CREATE TRIGGER pair_audit AFTER INSERT ON pair BEGIN SELECT 1; END',
    ]) {
      await runAll(session, sql);
    }
  }, 60_000);

  afterAll(async () => {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  it('lists triggers with their tables and nothing of other kinds', async () => {
    expect(await session.metadata.listObjects({}, 'trigger')).toEqual([
      { name: 'pair_audit', kind: 'trigger', table: 'pair' },
      { name: 'plain_audit', kind: 'trigger', table: 'plain' },
    ]);
    for (const kind of ['function', 'procedure', 'sequence', 'event'] as const) {
      expect(await session.metadata.listObjects({}, kind)).toEqual([]);
    }
  });

  it('lists indexes, including the automatic one behind UNIQUE and expressions', async () => {
    expect(await session.metadata.listIndexes({ name: 'plain' })).toEqual([
      { name: 'ix_plain_ab', columns: ['b', 'a'], unique: false, primary: false },
      { name: 'ix_plain_expr', columns: ['(expression)'], unique: false, primary: false },
      { name: 'sqlite_autoindex_plain_1', columns: ['code'], unique: true, primary: false },
    ]);
  });

  it('shows the primary key index of a WITHOUT ROWID table first', async () => {
    expect(await session.metadata.listIndexes({ name: 'pair' })).toEqual([
      { name: 'sqlite_autoindex_pair_1', columns: ['y', 'x'], unique: true, primary: true },
    ]);
  });
});
