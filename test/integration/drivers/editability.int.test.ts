// Whether a result is editable is decided from the statement and the table's
// structure; this checks it end to end against real servers, where the column names
// of a result and of the table really have to line up.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ResultEdit } from '../../../src/core/model/editability';
import { syntaxOf } from '../../../src/core/sql/tokenizer';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { analyzeEditability } from '../../../src/services/result-editability';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { RecordingLogger } from '../../helpers/fakes';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

function serverConfig(id: TestDatabaseId, driver: 'mysql' | 'postgres'): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `edit-${id}`,
    name: `edit ${id}`,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

interface Target {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  /** A table with a composite primary key, and its two key columns. */
  readonly composite: { table: string; keys: [string, string] };
  /** A view over other tables. */
  readonly view: string;
}

describe('result editability on real databases', () => {
  let worker: BuiltWorker;
  let dir: string;
  const sessions: Session[] = [];

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-editability-'));
  }, 60_000);

  afterAll(async () => {
    for (const session of sessions) {
      await session.close();
    }
    rmSync(dir, { recursive: true, force: true });
  });

  const targets: Target[] = [
    {
      label: 'mysql',
      driver: () => mysqlDriver,
      config: () => serverConfig('mysql', 'mysql'),
      composite: { table: 'order_items', keys: ['order_id', 'product_id'] },
      view: 'order_totals',
    },
    {
      label: 'mariadb',
      driver: () => mysqlDriver,
      config: () => serverConfig('mariadb', 'mysql'),
      composite: { table: 'order_items', keys: ['order_id', 'product_id'] },
      view: 'order_totals',
    },
    {
      label: 'postgres',
      driver: () => postgresDriver,
      config: () => serverConfig('postgres', 'postgres'),
      composite: { table: 'order_items', keys: ['order_id', 'product_id'] },
      view: 'order_totals',
    },
  ];

  async function analyze(session: Session, driver: Driver, sql: string): Promise<ResultEdit> {
    const result = await runAll(session, sql, { rowLimit: 1 });
    const columns = (result.columnSets[0] ?? []).map((column) => column.name);
    return await analyzeEditability(
      {
        metadata: session.metadata,
        syntax: syntaxOf(driver.id),
        schemas: driver.capabilities.schemas,
        logger: new RecordingLogger(),
      },
      sql,
      columns,
    );
  }

  describe.each(targets)('$label', (target) => {
    let session: Session;
    let driver: Driver;

    beforeAll(async () => {
      driver = target.driver();
      session = await driver.openSession(target.config());
      sessions.push(session);
    });

    it('edits a plain select of a table with a primary key', async () => {
      expect(await analyze(session, driver, 'SELECT * FROM customers')).toMatchObject({
        editable: true,
        table: { name: 'customers' },
        keyColumns: ['id'],
        keyIndexes: [0],
      });
    });

    it('follows aliases, filters and ordering', async () => {
      const edit = await analyze(
        session,
        driver,
        'SELECT email AS mail, id FROM customers c WHERE id > 0 ORDER BY id LIMIT 3',
      );
      expect(edit).toMatchObject({ editable: true, keyIndexes: [1], columnMap: ['email', 'id'] });
    });

    it('needs the whole composite key', async () => {
      const [first, second] = target.composite.keys;
      expect(
        await analyze(session, driver, `SELECT ${first}, ${second} FROM ${target.composite.table}`),
      ).toMatchObject({ editable: true, keyColumns: [first, second] });
      expect(
        await analyze(session, driver, `SELECT ${first} FROM ${target.composite.table}`),
      ).toEqual({
        editable: false,
        reason: 'key-not-selected',
      });
    });

    it('refuses a join, an aggregate and a computed key', async () => {
      expect(
        await analyze(
          session,
          driver,
          'SELECT o.id FROM orders o JOIN customers c ON c.id = o.customer_id',
        ),
      ).toEqual({ editable: false, reason: 'multiple-tables' });
      expect(
        await analyze(session, driver, 'SELECT country, COUNT(*) FROM customers GROUP BY country'),
      ).toEqual({
        editable: false,
        reason: 'grouped',
      });
      expect(await analyze(session, driver, 'SELECT id + 0 AS id FROM customers')).toEqual({
        editable: false,
        reason: 'key-not-selected',
      });
    });

    it('refuses a view', async () => {
      expect(await analyze(session, driver, `SELECT * FROM ${target.view}`)).toEqual({
        editable: false,
        reason: 'view',
      });
    });

    it('refuses a select without a table', async () => {
      expect(await analyze(session, driver, 'SELECT 1 AS id')).toEqual({
        editable: false,
        reason: 'no-table',
      });
    });
  });

  describe('postgres schemas and unique keys', () => {
    let session: Session;
    let driver: Driver;

    beforeAll(async () => {
      driver = postgresDriver;
      session = await driver.openSession(serverConfig('postgres', 'postgres'));
      sessions.push(session);
    });

    it('reads a schema-qualified table', async () => {
      expect(await analyze(session, driver, 'SELECT * FROM inventory.warehouses')).toMatchObject({
        editable: true,
        table: { schema: 'inventory', name: 'warehouses' },
      });
    });

    it('folds an unquoted name the way the server does', async () => {
      expect(await analyze(session, driver, 'SELECT id FROM Customers')).toMatchObject({
        editable: true,
        table: { name: 'customers' },
      });
    });

    it('edits by a NOT NULL unique key when the table has no primary key', async () => {
      await runAll(session, 'DROP TABLE IF EXISTS edit_nopk');
      await runAll(session, 'CREATE TABLE edit_nopk (code TEXT NOT NULL UNIQUE, note TEXT)');
      try {
        expect(await analyze(session, driver, 'SELECT * FROM edit_nopk')).toMatchObject({
          editable: true,
          keyColumns: ['code'],
        });
        await runAll(session, 'DROP TABLE edit_nopk');
        await runAll(session, 'CREATE TABLE edit_nopk (code TEXT UNIQUE, note TEXT)');
        expect(await analyze(session, driver, 'SELECT * FROM edit_nopk')).toEqual({
          editable: false,
          reason: 'no-key',
        });
      } finally {
        await runAll(session, 'DROP TABLE IF EXISTS edit_nopk');
      }
    });
  });

  describe('sqlite', () => {
    let session: Session;
    let driver: Driver;

    beforeAll(async () => {
      driver = createSqliteDriver({ workerPath: worker.workerPath });
      session = await driver.openSession({
        id: 'edit-sqlite',
        name: 'edit sqlite',
        driver: 'sqlite',
        file: join(dir, 'edit.db'),
      });
      sessions.push(session);
      await runAll(session, 'CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
      await runAll(session, 'CREATE TABLE tags (code TEXT NOT NULL UNIQUE, label TEXT)');
      await runAll(session, 'CREATE TABLE loose (a TEXT, b TEXT)');
      await runAll(session, 'CREATE VIEW v AS SELECT id FROM users');
    });

    it('edits a table with a primary key and by a unique key', async () => {
      expect(await analyze(session, driver, 'SELECT * FROM users')).toMatchObject({
        editable: true,
        keyColumns: ['id'],
      });
      expect(await analyze(session, driver, 'SELECT * FROM tags')).toMatchObject({
        editable: true,
        keyColumns: ['code'],
      });
    });

    it('refuses a table without a key, a view and a join', async () => {
      expect(await analyze(session, driver, 'SELECT * FROM loose')).toEqual({
        editable: false,
        reason: 'no-key',
      });
      expect(await analyze(session, driver, 'SELECT * FROM v')).toEqual({
        editable: false,
        reason: 'view',
      });
      expect(await analyze(session, driver, 'SELECT * FROM users u, tags t')).toEqual({
        editable: false,
        reason: 'multiple-tables',
      });
    });
  });
});
