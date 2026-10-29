// Dumps on real servers (V5.2), checked the only way that matters: the script is run
// on an empty database and everything must come back — rows, keys, views, routines,
// triggers, sequences — and running it a second time must work too.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableInfo } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { SessionTarget } from '../../../src/services/connection-manager';
import { type ScriptChunk, ScriptRunner } from '../../../src/services/script-runner';
import { type DumpContent, type DumpReport, SqlDumper } from '../../../src/services/sql-dump';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-dump-'));
});

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** Opens sessions on one connection; the target's database picks the database. */
class Connection {
  constructor(
    readonly driver: Driver,
    readonly config: (database?: string) => ResolvedConnectionConfig,
  ) {}

  manager(): ConstructorParameters<typeof SqlDumper>[0]['manager'] {
    const sessions = new Map<string, Session>();
    return {
      driverOf: () => Promise.resolve(this.driver),
      acquire: async (owner: string, target: SessionTarget) => {
        const session = await this.driver.openSession(this.config(target.database));
        sessions.set(owner, session);
        return session;
      },
      release: async (owner: string) => {
        await sessions.get(owner)?.close();
        sessions.delete(owner);
      },
    };
  }

  async use<T>(database: string | undefined, run: (session: Session) => Promise<T>): Promise<T> {
    const session = await this.driver.openSession(this.config(database));
    try {
      return await run(session);
    } finally {
      await session.close();
    }
  }
}

/** `asRoot`: MySQL lets only an administrator read others' routines and create triggers. */
function serverConnection(id: TestDatabaseId, driver: Driver, asRoot = false): Connection {
  const db = testDatabase(id);
  return new Connection(driver, (database) => ({
    id: `dump-${id}`,
    name: id,
    driver: id === 'postgres' ? 'postgres' : 'mysql',
    host: db.host,
    port: db.port,
    user: asRoot ? 'root' : db.user,
    password: asRoot ? 'datanest_root' : db.password,
    database: database ?? db.database,
  }));
}

class MemorySink {
  text = '';

  write(text: string): Promise<void> {
    this.text += text;
    return Promise.resolve();
  }
}

interface DumpOptions {
  readonly database?: string;
  readonly schema?: string;
  readonly relations?: (all: TableInfo[]) => TableInfo[];
  readonly wholeScope?: boolean;
  readonly content?: DumpContent;
  readonly dropFirst?: boolean;
}

async function dump(
  connection: Connection,
  options: DumpOptions,
): Promise<{ script: string; report: DumpReport }> {
  const scope = {
    ...(options.database === undefined ? {} : { database: options.database }),
    ...(options.schema === undefined ? {} : { schema: options.schema }),
  };
  const all = await connection.use(options.database, async (session) =>
    session.metadata.listTables(scope),
  );
  const sink = new MemorySink();
  const report = await new SqlDumper({
    manager: connection.manager(),
    logger: new RecordingLogger(),
  }).dump({
    target: {
      connectionId: 'c',
      ...(options.database === undefined ? {} : { database: options.database }),
    },
    scope,
    relations: options.relations?.(all) ?? all,
    wholeScope: options.wholeScope ?? true,
    content: options.content ?? 'all',
    dropFirst: options.dropFirst ?? true,
    sink,
    source: 'test',
  });
  return { script: sink.text, report };
}

async function* parts(text: string): AsyncGenerator<ScriptChunk> {
  for (let offset = 0; offset < text.length; offset += 4096) {
    await Promise.resolve();
    const piece = text.slice(offset, offset + 4096);
    yield { text: piece, bytes: piece.length };
  }
}

/** Runs the script on a database and expects every statement to succeed. */
async function restore(connection: Connection, database: string | undefined, script: string) {
  const report = await new ScriptRunner({
    manager: connection.manager(),
    logger: new RecordingLogger(),
  }).run({
    target: { connectionId: 'c', ...(database === undefined ? {} : { database }) },
    chunks: parts(script),
    continueOnError: false,
  });
  expect(report.stoppedAt, JSON.stringify(report.stoppedAt)).toBeUndefined();
  expect(report.failedCount).toBe(0);
  return report;
}

/** Every row of a table, sorted, for comparing two copies. */
async function rowsOf(
  connection: Connection,
  database: string | undefined,
  table: string,
): Promise<string[]> {
  return await connection.use(database, async (session) =>
    (await runAll(session, `SELECT * FROM ${table}`)).rows.map((row) => JSON.stringify(row)).sort(),
  );
}

describe.each([
  { label: 'mysql', id: 'mysql' as const },
  { label: 'mariadb', id: 'mariadb' as const },
])('$label', ({ id }) => {
  const connection = serverConnection(id, mysqlDriver, true);
  const source = 'datanest_test';
  const target = 'datanest_empty';
  const tables = ['customers', 'products', 'orders', 'order_items', 'all_types', 'big_table'];

  async function emptyTarget(): Promise<void> {
    await connection.use(target, async (session) => {
      await runAll(session, 'SET FOREIGN_KEY_CHECKS = 0');
      for (const table of await session.metadata.listTables({ database: target })) {
        await runAll(
          session,
          `DROP ${table.kind === 'view' ? 'VIEW' : 'TABLE'} IF EXISTS \`${table.name}\``,
        );
      }
      for (const kind of ['function', 'procedure'] as const) {
        for (const object of await session.metadata.listObjects({ database: target }, kind)) {
          await runAll(session, `DROP ${kind.toUpperCase()} IF EXISTS \`${object.name}\``);
        }
      }
    });
  }

  beforeAll(emptyTarget);
  afterAll(emptyTarget);

  it('restores a whole database: rows, view, routines and trigger', async () => {
    const { script, report } = await dump(connection, { database: source });
    expect(report.tables).toBe(tables.length);
    expect(report.views).toBe(1);
    expect(report.objects).toBe(2);
    expect(report.rows).toBeGreaterThan(10_000);
    expect(script).not.toMatch(/DEFINER\s*=/u);
    expect(script).not.toContain('`datanest_test`');
    await restore(connection, target, script);
    for (const table of [...tables, 'order_totals']) {
      expect(await rowsOf(connection, target, table), table).toEqual(
        await rowsOf(connection, source, table),
      );
    }
    await connection.use(target, async (session) => {
      expect(firstColumn(await runAll(session, 'SELECT order_total(1)'))).toEqual(
        await connection.use(source, async (s) =>
          firstColumn(await runAll(s, 'SELECT order_total(1)')),
        ),
      );
      const triggers = await session.metadata.listObjects({ database: target }, 'trigger');
      expect(triggers.map((trigger) => trigger.name)).toEqual(['order_items_quantity_check']);
      await expect(
        runAll(session, 'INSERT INTO order_items VALUES (1, 1, 0, 1.00)'),
      ).rejects.toThrow(/quantity must be positive/u);
    });
  });

  it('leaves out routines the user may not read, and says so', async () => {
    const plain = serverConnection(id, mysqlDriver);
    const { script, report } = await dump(plain, { database: source, content: 'structure' });
    if (id === 'mysql') {
      expect(report.skipped.map((skip) => skip.name).sort()).toEqual([
        'customer_orders',
        'order_total',
      ]);
      expect(script).toMatch(/-- Skipped function order_total: /u);
    } else {
      // MariaDB shows routines to anyone with rights on the database.
      expect(report.skipped).toEqual([]);
    }
    expect(script).toContain('CREATE TABLE `customers`');
  });

  it('runs again on top of itself thanks to DROP … IF EXISTS', async () => {
    const { script } = await dump(connection, { database: source });
    await restore(connection, target, script);
    expect(await rowsOf(connection, target, 'customers')).toEqual(
      await rowsOf(connection, source, 'customers'),
    );
  });

  it('dumps structure and data apart, for chosen tables only', async () => {
    await emptyTarget();
    const chosen = (all: TableInfo[]): TableInfo[] =>
      all.filter((table) => ['orders', 'order_items'].includes(table.name));
    const structure = await dump(connection, {
      database: source,
      relations: chosen,
      wholeScope: false,
      content: 'structure',
    });
    expect(structure.report.rows).toBe(0);
    expect(structure.script).not.toContain('INSERT INTO');
    expect(structure.script).not.toContain('order_total');
    await restore(connection, target, structure.script);
    expect(await rowsOf(connection, target, 'orders')).toEqual([]);
    const data = await dump(connection, {
      database: source,
      relations: chosen,
      wholeScope: false,
      content: 'data',
    });
    expect(data.script).not.toContain('CREATE TABLE');
    await restore(connection, target, data.script);
    expect(await rowsOf(connection, target, 'order_items')).toEqual(
      await rowsOf(connection, source, 'order_items'),
    );
  });
});

describe('postgres', () => {
  const connection = serverConnection('postgres', postgresDriver);
  const source = 'datanest_test';
  const target = 'datanest_empty';

  async function emptyTarget(): Promise<void> {
    await connection.use(target, async (session) => {
      await runAll(session, 'DROP SCHEMA IF EXISTS inventory CASCADE');
      await runAll(session, 'DROP SCHEMA IF EXISTS public CASCADE');
      await runAll(session, 'CREATE SCHEMA public');
    });
  }

  beforeAll(emptyTarget);
  afterAll(emptyTarget);

  it('restores the public schema into another database', async () => {
    const { script, report } = await dump(connection, { database: source, schema: 'public' });
    expect(report.views).toBe(2);
    // The enum, the standalone sequence, two functions and a procedure.
    expect(report.objects).toBe(5);
    await restore(connection, target, script);
    for (const table of [
      'public.customers',
      'public.products',
      'public.orders',
      'public.order_items',
      'public.all_types',
      'public.big_table',
      'public.order_totals',
      'public.product_sales',
    ]) {
      expect(await rowsOf(connection, target, table), table).toEqual(
        await rowsOf(connection, source, table),
      );
    }
    await connection.use(target, async (session) => {
      await expect(
        runAll(session, 'INSERT INTO public.order_items VALUES (1, 1, 0, 1.00)'),
      ).rejects.toThrow(/quantity must be positive/u);
      expect(firstColumn(await runAll(session, 'SELECT public.order_total(1)'))).toEqual(
        await connection.use(source, async (s) =>
          firstColumn(await runAll(s, 'SELECT public.order_total(1)')),
        ),
      );
    });
  });

  it('runs again on top of itself', async () => {
    const { script } = await dump(connection, { database: source, schema: 'public' });
    await restore(connection, target, script);
    expect(await rowsOf(connection, target, 'public.all_types')).toEqual(
      await rowsOf(connection, source, 'public.all_types'),
    );
  });

  it('restores a schema whose keys point into another one, and its sequences go on', async () => {
    const { script } = await dump(connection, { database: source, schema: 'inventory' });
    expect(script).toContain('CREATE SCHEMA IF NOT EXISTS "inventory"');
    expect(script).toContain('ALTER TABLE "inventory"."stock_levels" ADD CONSTRAINT');
    await restore(connection, target, script);
    for (const table of ['inventory.warehouses', 'inventory.stock_levels']) {
      expect(await rowsOf(connection, target, table), table).toEqual(
        await rowsOf(connection, source, table),
      );
    }
    await connection.use(target, async (session) => {
      const added = await runAll(
        session,
        "INSERT INTO inventory.warehouses (code, city) VALUES ('WH-NEW', 'Riga') RETURNING id",
      );
      expect(firstColumn(added)).toEqual([3]);
    });
  });

  it('keeps identity values and special floating-point values', async () => {
    await connection.use(source, async (session) => {
      await runAll(session, 'DROP TABLE IF EXISTS public.dump_identity');
      await runAll(
        session,
        `CREATE TABLE public.dump_identity (
           id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY, x float8, doubled int GENERATED ALWAYS AS (id * 2) STORED)`,
      );
      await runAll(
        session,
        "INSERT INTO public.dump_identity (x) VALUES ('NaN'), ('Infinity'), ('-Infinity'), (1.5)",
      );
    });
    try {
      const { script } = await dump(connection, {
        database: source,
        schema: 'public',
        relations: (all) => all.filter((table) => table.name === 'dump_identity'),
        wholeScope: false,
      });
      expect(script).toContain('OVERRIDING SYSTEM VALUE');
      await restore(connection, target, script);
      expect(await rowsOf(connection, target, 'public.dump_identity')).toEqual(
        await rowsOf(connection, source, 'public.dump_identity'),
      );
      await connection.use(target, async (session) => {
        const added = await runAll(
          session,
          'INSERT INTO public.dump_identity (x) VALUES (2) RETURNING id',
        );
        expect(firstColumn(added)).toEqual([5]);
      });
    } finally {
      await connection.use(source, async (session) => {
        await runAll(session, 'DROP TABLE IF EXISTS public.dump_identity');
      });
    }
  });
});

describe('sqlite', () => {
  const driver = (): Driver => createSqliteDriver({ workerPath: worker.workerPath });
  const fileConnection = (file: string): Connection =>
    new Connection(driver(), () => ({ id: 'dump-sqlite', name: 's', driver: 'sqlite', file }));

  it('restores a database file into a new one', async () => {
    const source = fileConnection(join(dir, 'source.db'));
    await source.use(undefined, async (session) => {
      for (const sql of [
        'CREATE TABLE authors (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL)',
        `CREATE TABLE books (id INTEGER PRIMARY KEY, author_id INTEGER REFERENCES authors (id),
           title TEXT, cover BLOB, price REAL, sold INTEGER DEFAULT 0)`,
        'CREATE INDEX ix_books_author ON books (author_id)',
        'CREATE TABLE log (book_id INTEGER)',
        'CREATE TRIGGER books_log AFTER INSERT ON books BEGIN INSERT INTO log VALUES (new.id); END',
        'CREATE VIEW titles AS SELECT title FROM books',
        'CREATE VIEW long_titles AS SELECT title FROM titles WHERE length(title) > 3',
        "INSERT INTO authors (name) VALUES ('Anna'), ('O''Neil')",
        "INSERT INTO books VALUES (1, 1, 'First; book', X'00FF10', 9.5, 3), (2, 2, 'Два', NULL, NULL, 0)",
        'DELETE FROM log WHERE book_id = 2',
      ]) {
        await runAll(session, sql);
      }
    });
    const { script } = await dump(source, {});
    expect(script.indexOf('CREATE VIEW titles')).toBeLessThan(
      script.indexOf('CREATE VIEW long_titles'),
    );
    expect(script.indexOf('INSERT INTO "books"')).toBeLessThan(
      script.indexOf('CREATE TRIGGER books_log'),
    );
    const copy = fileConnection(join(dir, 'copy.db'));
    await restore(copy, undefined, script);
    for (const table of ['authors', 'books', 'log', 'long_titles']) {
      expect(await rowsOf(copy, undefined, table), table).toEqual(
        await rowsOf(source, undefined, table),
      );
    }
    await copy.use(undefined, async (session) => {
      expect(
        firstColumn(await runAll(session, "INSERT INTO authors (name) VALUES ('C') RETURNING id")),
      ).toEqual([3]);
      await runAll(session, "INSERT INTO books (id, title) VALUES (3, 'x')");
      expect(firstColumn(await runAll(session, 'SELECT count(*) FROM log'))).toEqual([2]);
    });
  });

  it('stops with a cancelled error in the middle of the rows and lets the session go', async () => {
    const source = fileConnection(join(dir, 'big.db'));
    await source.use(undefined, async (session) => {
      await runAll(session, 'CREATE TABLE numbers (n INTEGER PRIMARY KEY)');
      await runAll(
        session,
        'INSERT INTO numbers WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < 50000) SELECT n FROM g',
      );
    });
    const abort = new AbortController();
    const released: string[] = [];
    const manager = source.manager();
    const dumped = new SqlDumper({
      manager: {
        ...manager,
        release: async (owner) => {
          released.push(owner);
          await manager.release(owner);
        },
      },
      logger: new RecordingLogger(),
    }).dump({
      target: { connectionId: 'c' },
      scope: {},
      relations: [{ name: 'numbers', kind: 'table' }],
      wholeScope: false,
      content: 'all',
      dropFirst: false,
      sink: new MemorySink(),
      source: 'test',
      signal: abort.signal,
      onProgress: (progress) => {
        if (progress.rows >= 1000) {
          abort.abort();
        }
      },
    });
    await expect(dumped).rejects.toMatchObject({ code: 'cancelled' });
    expect(released).toHaveLength(1);
  });
});
