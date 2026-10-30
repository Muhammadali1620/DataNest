// The ER diagram (V8.1) on real servers: tables, key columns and the keys between
// them as the drivers report them, composite and self-referencing keys included,
// and keys that lead out of the drawn tables.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectScope } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { readErSchema } from '../../../src/services/er-diagram';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-er-'));
}, 60_000);

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface Target {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  readonly scope: ObjectScope;
  readonly setup: readonly string[];
  readonly teardown: readonly string[];
}

const TABLES = ['er_customers', 'er_orders', 'er_lines', 'er_categories', 'er_pairs', 'er_refs'];

const MYSQL_SETUP = [
  'DROP TABLE IF EXISTS er_refs, er_pairs, er_categories, er_lines, er_orders, er_customers',
  'CREATE TABLE er_customers (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL)',
  `CREATE TABLE er_orders (id INT PRIMARY KEY, customer_id INT NOT NULL, note TEXT,
     CONSTRAINT er_orders_customer FOREIGN KEY (customer_id) REFERENCES er_customers (id))`,
  `CREATE TABLE er_lines (order_id INT, line_no INT, qty INT, PRIMARY KEY (order_id, line_no),
     CONSTRAINT er_lines_order FOREIGN KEY (order_id) REFERENCES er_orders (id))`,
  `CREATE TABLE er_categories (id INT PRIMARY KEY, parent_id INT NULL,
     CONSTRAINT er_categories_parent FOREIGN KEY (parent_id) REFERENCES er_categories (id))`,
  'CREATE TABLE er_pairs (a INT, b INT, PRIMARY KEY (a, b), UNIQUE KEY er_pairs_ba (b, a))',
  `CREATE TABLE er_refs (id INT PRIMARY KEY, pa INT NULL, pb INT NULL,
     CONSTRAINT er_refs_pair FOREIGN KEY (pb, pa) REFERENCES er_pairs (b, a))`,
];
const MYSQL_TEARDOWN = [
  'DROP TABLE IF EXISTS er_refs, er_pairs, er_categories, er_lines, er_orders, er_customers',
];

function server(id: TestDatabaseId, driver: Driver): Target {
  return {
    label: id,
    driver: () => driver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `er-${id}`,
        name: id,
        driver: 'mysql',
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
      };
    },
    scope: { database: testDatabase(id).database },
    setup: MYSQL_SETUP,
    teardown: MYSQL_TEARDOWN,
  };
}

const TARGETS: readonly Target[] = [
  server('mysql', mysqlDriver),
  server('mariadb', mysqlDriver),
  {
    label: 'postgres',
    driver: () => postgresDriver,
    config: () => {
      const db = testDatabase('postgres');
      return {
        id: 'er-postgres',
        name: 'postgres',
        driver: 'postgres',
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
      };
    },
    scope: { schema: 'er_main' },
    setup: [
      'DROP SCHEMA IF EXISTS er_main CASCADE',
      'DROP SCHEMA IF EXISTS er_other CASCADE',
      'CREATE SCHEMA er_main',
      'CREATE SCHEMA er_other',
      'CREATE TABLE er_other.er_regions (code text PRIMARY KEY)',
      `CREATE TABLE er_main.er_customers (id int PRIMARY KEY, name varchar(50) NOT NULL,
         region text REFERENCES er_other.er_regions (code))`,
      `CREATE TABLE er_main.er_orders (id int PRIMARY KEY, customer_id int NOT NULL, note text,
         CONSTRAINT er_orders_customer FOREIGN KEY (customer_id) REFERENCES er_main.er_customers (id))`,
      `CREATE TABLE er_main.er_lines (order_id int, line_no int, qty int, PRIMARY KEY (order_id, line_no),
         CONSTRAINT er_lines_order FOREIGN KEY (order_id) REFERENCES er_main.er_orders (id))`,
      `CREATE TABLE er_main.er_categories (id int PRIMARY KEY, parent_id int,
         CONSTRAINT er_categories_parent FOREIGN KEY (parent_id) REFERENCES er_main.er_categories (id))`,
      'CREATE TABLE er_main.er_pairs (a int, b int, PRIMARY KEY (a, b))',
      `CREATE TABLE er_main.er_refs (id int PRIMARY KEY, pa int, pb int,
         CONSTRAINT er_refs_pair FOREIGN KEY (pb, pa) REFERENCES er_main.er_pairs (b, a))`,
      'CREATE VIEW er_main.er_order_view AS SELECT id FROM er_main.er_orders',
    ],
    teardown: ['DROP SCHEMA IF EXISTS er_main CASCADE', 'DROP SCHEMA IF EXISTS er_other CASCADE'],
  },
  {
    label: 'sqlite',
    driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
    config: () => ({ id: 'er-sqlite', name: 'sqlite', driver: 'sqlite', file: join(dir, 'er.db') }),
    scope: {},
    setup: [
      'CREATE TABLE er_customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL)',
      `CREATE TABLE er_orders (id INTEGER PRIMARY KEY, customer_id INTEGER NOT NULL
         CONSTRAINT er_orders_customer REFERENCES er_customers (id), note TEXT)`,
      `CREATE TABLE er_lines (order_id INTEGER REFERENCES er_orders (id), line_no INTEGER,
         qty INTEGER, PRIMARY KEY (order_id, line_no))`,
      'CREATE TABLE er_categories (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES er_categories (id))',
      'CREATE TABLE er_pairs (a INTEGER, b INTEGER, PRIMARY KEY (a, b))',
      `CREATE TABLE er_refs (id INTEGER PRIMARY KEY, pa INTEGER, pb INTEGER,
         FOREIGN KEY (pb, pa) REFERENCES er_pairs (b, a))`,
      'CREATE VIEW er_order_view AS SELECT id FROM er_orders',
    ],
    teardown: [],
  },
];

describe.each(TARGETS)('ER diagram on $label', (target) => {
  let session: Session;

  beforeAll(async () => {
    session = await target.driver().openSession(target.config());
    for (const sql of target.setup) {
      await runAll(session, sql);
    }
  }, 60_000);

  afterAll(async () => {
    for (const sql of target.teardown) {
      await runAll(session, sql);
    }
    await session.close();
  });

  const read = async (tables: readonly string[] = TABLES) =>
    await readErSchema(session.metadata, target.scope, { tables });

  it('reads every chosen table with its columns and key marks', async () => {
    const schema = await read();
    const local = schema.tables.filter((table) => table.external !== true);
    expect(local.map((table) => table.id).sort()).toEqual([...TABLES].sort());
    const orders = local.find((table) => table.id === 'er_orders');
    expect(
      orders?.columns.map((column) => [column.name, column.primaryKey, column.foreignKey]),
    ).toEqual([
      ['id', true, false],
      ['customer_id', false, true],
      ['note', false, false],
    ]);
    const lines = local.find((table) => table.id === 'er_lines');
    expect(
      lines?.columns.filter((column) => column.primaryKey).map((column) => column.name),
    ).toEqual(['order_id', 'line_no']);
  });

  it('turns foreign keys into relations', async () => {
    const schema = await read();
    const byFrom = (from: string) => schema.relations.filter((relation) => relation.from === from);
    expect(byFrom('er_orders')).toMatchObject([
      {
        from: 'er_orders',
        to: 'er_customers',
        columns: ['customer_id'],
        targetColumns: ['id'],
        optional: false,
      },
    ]);
    expect(byFrom('er_categories')).toMatchObject([
      { to: 'er_categories', columns: ['parent_id'], targetColumns: ['id'], optional: true },
    ]);
    expect(byFrom('er_refs')).toMatchObject([
      { to: 'er_pairs', columns: ['pb', 'pa'], targetColumns: ['b', 'a'], optional: true },
    ]);
  });

  it('draws a table that a chosen one points at as a table elsewhere', async () => {
    const schema = await read(['er_lines']);
    const external = schema.tables.filter((table) => table.external === true);
    expect(external.map((table) => table.label)).toEqual(['er_orders']);
    expect(external[0]?.columns.map((column) => column.name)).toEqual(['id']);
    expect(schema.relations[0]?.to).toBe(external[0]?.id);
  });

  it('leaves views out of the whole scope', async () => {
    const schema = await readErSchema(session.metadata, target.scope, {
      tables: [...TABLES, 'er_order_view'],
    });
    expect(schema.tables.map((table) => table.label)).not.toContain('er_order_view');
  });
});

describe('ER diagram of a whole PostgreSQL schema', () => {
  let session: Session;

  beforeAll(async () => {
    const target = TARGETS.find((one) => one.label === 'postgres');
    if (target === undefined) {
      throw new Error('no postgres target');
    }
    session = await target.driver().openSession(target.config());
    for (const sql of target.setup) {
      await runAll(session, sql);
    }
  }, 60_000);

  afterAll(async () => {
    await runAll(session, 'DROP SCHEMA IF EXISTS er_main CASCADE');
    await runAll(session, 'DROP SCHEMA IF EXISTS er_other CASCADE');
    await session.close();
  });

  it('brings in the referenced table of another schema with its schema in the label', async () => {
    const schema = await readErSchema(session.metadata, { schema: 'er_main' });
    expect(schema.tables.filter((table) => table.external !== true)).toHaveLength(TABLES.length);
    const external = schema.tables.filter((table) => table.external === true);
    expect(external.map((table) => table.label)).toEqual(['er_other.er_regions']);
    const relation = schema.relations.find((one) => one.from === 'er_customers');
    expect(relation).toMatchObject({
      columns: ['region'],
      targetColumns: ['code'],
      optional: true,
    });
    expect(relation?.to).toBe(external[0]?.id);
  });
});
