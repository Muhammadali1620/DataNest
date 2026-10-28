// Object definitions (DDL) read from real servers. The strongest check is the round
// trip: a definition is dropped, run back, and must read exactly the same again.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import type { ObjectRef } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { definitionDocument } from '../../../src/services/object-definitions';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

function serverConfig(id: TestDatabaseId, driver: DriverId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `ddl-${id}`,
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

/** Runs a script the way the editor does: split, then one statement at a time. */
async function runScript(session: Session, script: string, driver: DriverId): Promise<void> {
  for (const statement of splitStatements(script, driver)) {
    await runAll(session, statement.text);
  }
}

/** Reads, drops, runs the definition back and reads again. */
async function roundTrip(
  session: Session,
  driver: DriverId,
  object: ObjectRef,
  drop: string,
): Promise<{ before: string[]; after: string[] }> {
  const before = await session.metadata.getDefinition(object);
  await runAll(session, drop);
  await runScript(session, definitionDocument(before, driver), driver);
  const after = await session.metadata.getDefinition(object);
  return { before, after };
}

describe.each(['mysql', 'mariadb'] as const)('definitions on %s', (serverId) => {
  let session: Session;
  const database = testDatabase(serverId).database;

  beforeAll(async () => {
    session = await mysqlDriver.openSession(serverConfig(serverId, 'mysql'));
    await runAll(session, 'DROP TABLE IF EXISTS ddl_probe');
    await runAll(session, 'DROP PROCEDURE IF EXISTS ddl_proc');
    await runAll(session, 'DROP EVENT IF EXISTS ddl_event');
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS ddl_probe');
    await runAll(session, 'DROP PROCEDURE IF EXISTS ddl_proc');
    await runAll(session, 'DROP EVENT IF EXISTS ddl_event');
    await session.close();
  });

  it('shows a table with its keys', async () => {
    const [ddl] = await session.metadata.getDefinition({
      database,
      kind: 'table',
      name: 'customers',
    });
    expect(ddl).toMatch(/^CREATE TABLE `customers`/);
    expect(ddl).toContain('UNIQUE KEY `uq_customers_email`');
    expect(ddl).toContain("COMMENT='Shop customers'");
  });

  it('works without a database in the reference (the session database)', async () => {
    const [ddl] = await session.metadata.getDefinition({ kind: 'table', name: 'orders' });
    expect(ddl).toContain('CONSTRAINT `fk_orders_customer` FOREIGN KEY');
  });

  it('round-trips a table with an index, a foreign key, defaults and comments', async () => {
    await runAll(
      session,
      `CREATE TABLE ddl_probe (
         id INT AUTO_INCREMENT PRIMARY KEY,
         customer_id INT NOT NULL COMMENT 'who; ordered',
         label VARCHAR(40) NOT NULL DEFAULT 'it''s',
         created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         KEY ix_probe_label (label),
         CONSTRAINT fk_probe_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
       ) COMMENT = 'probe table'`,
    );
    const { before, after } = await roundTrip(
      session,
      'mysql',
      { database, kind: 'table', name: 'ddl_probe' },
      'DROP TABLE ddl_probe',
    );
    // MySQL prints a column collation alone the first time and with its character
    // set once it was spelled out; both mean the same column.
    const plain = (statements: string[]) =>
      statements.map((statement) => statement.replaceAll('CHARACTER SET utf8mb4 ', ''));
    expect(plain(after)).toEqual(plain(before));
    expect(before[0]).toContain("COMMENT 'who; ordered'");
  });

  it('shows a view', async () => {
    const [ddl] = await session.metadata.getDefinition({
      database,
      kind: 'view',
      name: 'order_totals',
    });
    expect(ddl).toMatch(/^CREATE .*VIEW `order_totals` AS select/i);
  });

  it('shows a function and a procedure, or says the server hides them', async () => {
    // The seed routines belong to root. MySQL 8 shows another user's body only with
    // SHOW_ROUTINE; MariaDB shows it to anyone who may create routines here.
    const read = async (kind: 'function' | 'procedure', name: string) => {
      try {
        return (await session.metadata.getDefinition({ database, kind, name }))[0];
      } catch (error) {
        expect(error).toMatchObject({
          code: 'permission-denied',
          message: `The server does not show the definition of ${name} to this user`,
        });
        return undefined;
      }
    };
    const fn = await read('function', 'order_total');
    const proc = await read('procedure', 'customer_orders');
    if (serverId === 'mariadb') {
      expect(fn).toMatch(/FUNCTION `order_total`/);
      expect(fn).toContain('RETURN result;');
      expect(proc).toMatch(/PROCEDURE `customer_orders`/);
    }
  });

  it('round-trips a procedure through the DELIMITER script', async () => {
    await runAll(
      session,
      `CREATE PROCEDURE ddl_proc(IN p INT)
       BEGIN
         SELECT p AS first;
         SELECT 'a;b' AS second;
       END`,
    );
    const { before, after } = await roundTrip(
      session,
      'mysql',
      { database, kind: 'procedure', name: 'ddl_proc' },
      'DROP PROCEDURE ddl_proc',
    );
    expect(after).toEqual(before);
    expect(definitionDocument(before, 'mysql')).toMatch(/^DELIMITER \/\//);
  });

  it('shows a trigger and an event', async () => {
    const [trigger] = await session.metadata.getDefinition({
      database,
      kind: 'trigger',
      name: 'order_items_quantity_check',
      table: 'order_items',
    });
    // MariaDB keeps the statement as it was written, MySQL quotes the names.
    expect(trigger).toMatch(
      /TRIGGER `?order_items_quantity_check`?\s+BEFORE INSERT ON `?order_items`?/,
    );
    await runAll(session, 'CREATE EVENT ddl_event ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1');
    const [event] = await session.metadata.getDefinition({
      database,
      kind: 'event',
      name: 'ddl_event',
    });
    expect(event).toMatch(/EVENT `ddl_event` ON SCHEDULE EVERY 1 DAY/);
  });

  it('reports a missing object of any kind as not-found', async () => {
    for (const kind of ['table', 'view', 'function', 'procedure', 'trigger', 'event'] as const) {
      await expect(
        session.metadata.getDefinition({ database, kind, name: 'no_such_object' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    }
  });

  it('quotes names, so a strange name cannot break out of the statement', async () => {
    await expect(
      session.metadata.getDefinition({
        database,
        kind: 'table',
        name: 'x`; DROP TABLE orders; --',
      }),
    ).rejects.toMatchObject({ code: 'not-found' });
    const [ddl] = await session.metadata.getDefinition({ database, kind: 'table', name: 'orders' });
    expect(ddl).toContain('CREATE TABLE `orders`');
  });
});

describe('definitions on postgres', () => {
  let session: Session;

  beforeAll(async () => {
    session = await postgresDriver.openSession(serverConfig('postgres', 'postgres'));
    await runAll(session, 'DROP TABLE IF EXISTS ddl_probe');
    await runAll(session, 'DROP FUNCTION IF EXISTS ddl_touch()');
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS ddl_probe');
    await runAll(session, 'DROP FUNCTION IF EXISTS ddl_touch()');
    await session.close();
  });

  it('builds a table from the catalogs', async () => {
    const [table] = await session.metadata.getDefinition({
      schema: 'public',
      kind: 'table',
      name: 'customers',
    });
    expect(table).toMatch(/^CREATE TABLE "public"."customers" \(/);
    expect(table).toContain('"email" character varying(255) NOT NULL');
    expect(table).toMatch(/CONSTRAINT "customers_pkey" PRIMARY KEY \(id\)/);
  });

  it('defaults to the public schema', async () => {
    const statements = await session.metadata.getDefinition({ kind: 'table', name: 'products' });
    expect(statements[0]).toMatch(/^CREATE TABLE "public"."products"/);
    // A plain index is its own statement; the ones behind keys are not repeated.
    expect(statements).toContain(
      'CREATE INDEX ix_products_name ON public.products USING btree (name)',
    );
    expect(statements.filter((s) => s.includes('products_sku_key'))).toHaveLength(1);
  });

  it('round-trips a table with identity, generated, checks, keys, indexes, comments and a trigger', async () => {
    await runAll(
      session,
      `CREATE FUNCTION ddl_touch() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN NEW.label := trim(NEW.label); RETURN NEW; END; $$`,
    );
    await runAll(
      session,
      `CREATE TABLE ddl_probe (
         id integer GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         customer_id integer NOT NULL REFERENCES customers (id) ON DELETE CASCADE,
         label text COLLATE "C" NOT NULL DEFAULT 'it''s',
         price numeric(10, 2) CHECK (price >= 0),
         doubled numeric GENERATED ALWAYS AS (price * 2) STORED,
         code varchar(10) UNIQUE
       )`,
    );
    await runAll(session, 'CREATE INDEX ix_probe_label ON ddl_probe (lower(label))');
    await runAll(session, 'CREATE INDEX ix_probe_partial ON ddl_probe (price) WHERE price > 10');
    await runAll(session, "COMMENT ON TABLE ddl_probe IS 'probe; table'");
    await runAll(session, "COMMENT ON COLUMN ddl_probe.label IS 'what it''s called'");
    await runAll(
      session,
      'CREATE TRIGGER ddl_probe_touch BEFORE INSERT ON ddl_probe FOR EACH ROW EXECUTE FUNCTION ddl_touch()',
    );
    const { before, after } = await roundTrip(
      session,
      'postgres',
      { schema: 'public', kind: 'table', name: 'ddl_probe' },
      'DROP TABLE ddl_probe',
    );
    expect(after).toEqual(before);
    const text = before.join('\n');
    expect(text).toContain('"id" integer GENERATED ALWAYS AS IDENTITY NOT NULL');
    expect(text).toContain(
      '"label" text COLLATE pg_catalog."C" DEFAULT \'it\'\'s\'::text NOT NULL',
    );
    expect(text).toMatch(/"doubled" numeric GENERATED ALWAYS AS \(.*price \* .*2.*\) STORED/);
    expect(text).toContain('ON DELETE CASCADE');
    expect(text).toContain('COMMENT ON TABLE "public"."ddl_probe" IS \'probe; table\'');
    expect(text).toContain('CREATE TRIGGER ddl_probe_touch BEFORE INSERT ON ddl_probe');
  });

  it('shows views and materialized views', async () => {
    const [view] = await session.metadata.getDefinition({ kind: 'view', name: 'order_totals' });
    expect(view).toMatch(/^CREATE OR REPLACE VIEW "public"."order_totals" AS\n\s*SELECT/);
    expect(view?.endsWith(';')).toBe(false);
    const [matview] = await session.metadata.getDefinition({
      kind: 'view',
      name: 'product_sales',
    });
    expect(matview).toMatch(/^CREATE MATERIALIZED VIEW "public"."product_sales" AS/);
  });

  it('shows a function by signature, or every overload without one', async () => {
    const [fn] = await session.metadata.getDefinition({
      kind: 'function',
      name: 'order_total',
      signature: 'p_order_id integer',
    });
    expect(fn).toMatch(/^CREATE OR REPLACE FUNCTION public\.order_total\(p_order_id integer\)/);
    expect(await session.metadata.getDefinition({ kind: 'function', name: 'order_total' })).toEqual(
      [fn],
    );
    await expect(
      session.metadata.getDefinition({ kind: 'function', name: 'order_total', signature: 'text' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('shows a procedure, not a function of the same kind of name', async () => {
    const [proc] = await session.metadata.getDefinition({ kind: 'procedure', name: 'restock' });
    expect(proc).toMatch(/^CREATE OR REPLACE PROCEDURE public\.restock/);
    await expect(
      session.metadata.getDefinition({ kind: 'function', name: 'restock' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('shows a trigger and a sequence with its owner', async () => {
    const [trigger] = await session.metadata.getDefinition({
      kind: 'trigger',
      name: 'order_items_quantity_check',
      table: 'order_items',
    });
    expect(trigger).toMatch(/^CREATE TRIGGER order_items_quantity_check BEFORE INSERT/);
    const [sequence] = await session.metadata.getDefinition({
      kind: 'sequence',
      name: 'invoice_number_seq',
    });
    expect(sequence).toContain('CREATE SEQUENCE "public"."invoice_number_seq"');
    expect(sequence).toContain('START WITH 1000');
    const owned = await session.metadata.getDefinition({
      schema: 'inventory',
      kind: 'sequence',
      name: 'warehouses_id_seq',
    });
    expect(owned[1]).toBe(
      'ALTER SEQUENCE "inventory"."warehouses_id_seq" OWNED BY inventory.warehouses.id',
    );
  });

  it('reads objects of another schema', async () => {
    const [table] = await session.metadata.getDefinition({
      schema: 'inventory',
      kind: 'table',
      name: 'stock_levels',
    });
    expect(table).toContain('REFERENCES inventory.warehouses(id)');
  });

  it('reports missing objects and events', async () => {
    for (const kind of ['table', 'view', 'function', 'procedure', 'trigger', 'sequence'] as const) {
      await expect(
        session.metadata.getDefinition({ kind, name: 'no_such_object' }),
      ).rejects.toMatchObject({ code: 'not-found' });
    }
    await expect(
      session.metadata.getDefinition({ kind: 'event', name: 'x' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('definitions on sqlite', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let dir: string;
  let session: Session;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-ddl-'));
    session = await driver.openSession({
      id: 'ddl-sqlite',
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'ddl.db'),
    });
    await runScript(
      session,
      `CREATE TABLE parent (id INTEGER PRIMARY KEY, code TEXT UNIQUE);
       CREATE TABLE child (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         parent_id INTEGER REFERENCES parent (id),
         note TEXT DEFAULT 'a;b'
       );
       CREATE INDEX ix_child_parent ON child (parent_id);
       CREATE TRIGGER child_note AFTER INSERT ON child BEGIN
         UPDATE child SET note = upper(note) WHERE id = NEW.id;
       END;
       CREATE VIEW child_view AS SELECT id, note FROM child;`,
      'sqlite',
    );
  }, 60_000);

  afterAll(async () => {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  it('shows a table with its indexes and triggers, but not automatic indexes', async () => {
    const statements = await session.metadata.getDefinition({ kind: 'table', name: 'child' });
    expect(statements[0]).toMatch(/^CREATE TABLE child \(/);
    expect(statements).toContain('CREATE INDEX ix_child_parent ON child (parent_id)');
    expect(statements.some((s) => s.startsWith('CREATE TRIGGER child_note'))).toBe(true);
    const parent = await session.metadata.getDefinition({ kind: 'table', name: 'parent' });
    expect(parent).toHaveLength(1);
  });

  it('round-trips a table through the script', async () => {
    const { before, after } = await roundTrip(
      session,
      'sqlite',
      { kind: 'table', name: 'child' },
      'DROP TABLE child',
    );
    expect(after).toEqual(before);
  });

  it('shows a view and a trigger', async () => {
    expect(await session.metadata.getDefinition({ kind: 'view', name: 'child_view' })).toEqual([
      'CREATE VIEW child_view AS SELECT id, note FROM child',
    ]);
    const [trigger] = await session.metadata.getDefinition({
      kind: 'trigger',
      name: 'child_note',
    });
    expect(trigger).toMatch(/^CREATE TRIGGER child_note AFTER INSERT ON child BEGIN/);
  });

  it('reports missing objects and kinds SQLite does not have', async () => {
    await expect(
      session.metadata.getDefinition({ kind: 'table', name: 'nope' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    await expect(
      session.metadata.getDefinition({ kind: 'view', name: 'child' }),
    ).rejects.toMatchObject({ code: 'not-found' });
    for (const kind of ['function', 'procedure', 'sequence', 'event'] as const) {
      await expect(session.metadata.getDefinition({ kind, name: 'x' })).rejects.toMatchObject({
        code: 'unsupported',
      });
    }
  });
});
