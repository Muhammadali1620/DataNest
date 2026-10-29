// Copying tables between real servers of different kinds (V5.6): the seed shop goes
// from MySQL to PostgreSQL and SQLite and back, with its keys, numbering and every
// row, and the type-rich table arrives without a single refused value.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectScope } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { SessionTarget } from '../../../src/services/connection-manager';
import {
  type TransferReport,
  type TransferRequest,
  TableTransferService,
} from '../../../src/services/transfer/table-transfer';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-transfer-'));
});

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

/** One side of a transfer: how to open it and where the tables live. */
interface End {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  readonly scope: ObjectScope;
  /** How SQL in this test names a table here. */
  readonly name: (table: string) => string;
}

function server(id: TestDatabaseId, driver: Driver, database: string): End {
  const postgres = id === 'postgres';
  return {
    label: `${id}/${database}`,
    driver: () => driver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `tr-${id}-${database}`,
        name: id,
        driver: postgres ? 'postgres' : 'mysql',
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database,
      };
    },
    scope: postgres ? { database, schema: 'public' } : { database },
    name: (table) => (postgres ? `public.${table}` : table),
  };
}

function sqliteEnd(file: string): End {
  return {
    label: `sqlite/${file}`,
    driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
    config: () => ({ id: `tr-${file}`, name: 's', driver: 'sqlite', file: join(dir, file) }),
    scope: {},
    name: (table) => table,
  };
}

async function use<T>(end: End, run: (session: Session) => Promise<T>): Promise<T> {
  const session = await end.driver().openSession(end.config());
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

async function transfer(
  from: End,
  to: End,
  tables: string[],
  overrides: Partial<TransferRequest> = {},
): Promise<TransferReport> {
  const drivers = new Map([
    ['from', from],
    ['to', to],
  ]);
  const sessions = new Map<string, Session>();
  const service = new TableTransferService({
    manager: {
      driverOf: (connectionId) => Promise.resolve((drivers.get(connectionId) ?? from).driver()),
      acquire: async (owner, target: SessionTarget) => {
        const end = drivers.get(target.connectionId) ?? from;
        const session = await end.driver().openSession(end.config());
        sessions.set(owner, session);
        return session;
      },
      release: async (owner) => {
        await sessions.get(owner)?.close();
      },
    },
    logger: new RecordingLogger(),
  });
  return await service.transfer({
    source: { target: { connectionId: 'from' }, scope: from.scope },
    destination: { target: { connectionId: 'to' }, scope: to.scope },
    tables,
    content: 'all',
    existing: 'replace',
    ...overrides,
  });
}

async function count(end: End, table: string): Promise<number> {
  return await use(end, async (session) =>
    Number(firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${end.name(table)}`))[0]),
  );
}

async function emails(end: End): Promise<string[]> {
  return await use(end, async (session) =>
    firstColumn(
      await runAll(session, `SELECT email FROM ${end.name('customers')} ORDER BY id`),
    ).map(String),
  );
}

const SHOP = ['customers', 'products', 'orders', 'order_items'];

async function emptyMysql(end: End): Promise<void> {
  await use(end, async (session) => {
    await runAll(session, 'SET FOREIGN_KEY_CHECKS = 0');
    for (const table of await session.metadata.listTables(end.scope)) {
      await runAll(session, `DROP TABLE IF EXISTS \`${table.name}\``);
    }
  });
}

async function emptyPostgres(end: End): Promise<void> {
  await use(end, async (session) => {
    await runAll(session, 'DROP SCHEMA IF EXISTS public CASCADE');
    await runAll(session, 'CREATE SCHEMA public');
  });
}

const mysqlShop = server('mysql', mysqlDriver, 'datanest_test');
const mysqlEmpty = server('mysql', mysqlDriver, 'datanest_empty');
const mariadbEmpty = server('mariadb', mysqlDriver, 'datanest_empty');
const postgresShop = server('postgres', postgresDriver, 'datanest_test');
const postgresEmpty = server('postgres', postgresDriver, 'datanest_empty');

describe('MySQL to PostgreSQL', () => {
  beforeAll(async () => {
    await emptyPostgres(postgresEmpty);
  });

  afterAll(async () => {
    await emptyPostgres(postgresEmpty);
  });

  it('copies the shop with its keys and numbering', async () => {
    const report = await transfer(mysqlShop, postgresEmpty, [...SHOP, 'all_types', 'big_table']);
    expect(report.outcome).toBe('done');
    for (const table of report.tables) {
      expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
      expect(table.outcome).toBe('copied');
    }
    for (const table of [...SHOP, 'all_types', 'big_table']) {
      expect(await count(postgresEmpty, table), table).toBe(await count(mysqlShop, table));
    }
    expect(await emails(postgresEmpty)).toEqual(await emails(mysqlShop));
    await use(postgresEmpty, async (session) => {
      // The foreign keys came along: an order of a customer who does not exist is refused.
      await expect(
        runAll(session, 'INSERT INTO public.orders (customer_id, ordered_at) VALUES (999, now())'),
      ).rejects.toMatchObject({ code: 'constraint' });
      // Numbering goes on after the copied ids.
      const added = await runAll(
        session,
        "INSERT INTO public.customers (email) VALUES ('new@example.com') RETURNING id",
      );
      expect(Number(firstColumn(added)[0])).toBeGreaterThan(5);
      const active = firstColumn(
        await runAll(session, 'SELECT is_active FROM public.products ORDER BY id'),
      );
      expect(active.every((value) => typeof value === 'boolean')).toBe(true);
    });
  });
});

describe('PostgreSQL to MySQL', () => {
  beforeAll(async () => {
    await emptyMysql(mysqlEmpty);
  });

  afterAll(async () => {
    await emptyMysql(mysqlEmpty);
  });

  it('copies the shop, a custom enum type becoming text', async () => {
    const report = await transfer(postgresShop, mysqlEmpty, [...SHOP, 'all_types']);
    for (const table of report.tables) {
      expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
    }
    for (const table of [...SHOP, 'all_types']) {
      expect(await count(mysqlEmpty, table), table).toBe(await count(postgresShop, table));
    }
    expect(await emails(mysqlEmpty)).toEqual(await emails(postgresShop));
    await use(mysqlEmpty, async (session) => {
      await expect(
        runAll(session, 'INSERT INTO orders (customer_id, ordered_at) VALUES (999, NOW())'),
      ).rejects.toMatchObject({ code: 'constraint' });
    });
  });

  it('adds rows to tables that are there, or leaves them alone', async () => {
    const before = await count(mysqlEmpty, 'customers');
    await use(mysqlEmpty, async (session) => {
      await runAll(session, 'DELETE FROM order_items');
      await runAll(session, 'DELETE FROM orders');
      await runAll(session, 'DELETE FROM customers');
    });
    const appended = await transfer(postgresShop, mysqlEmpty, ['customers'], {
      existing: 'append',
    });
    expect(appended.tables[0]).toMatchObject({ outcome: 'copied', created: false, rows: before });
    const skipped = await transfer(postgresShop, mysqlEmpty, ['customers'], { existing: 'skip' });
    expect(skipped.tables[0]).toMatchObject({ outcome: 'skipped', rows: 0 });
    expect(await count(mysqlEmpty, 'customers')).toBe(before);
  });
});

describe('to and from SQLite', () => {
  const file = sqliteEnd('shop.db');
  const back = server('postgres', postgresDriver, 'datanest_empty');

  afterAll(async () => {
    await emptyPostgres(back);
  });

  it('copies MySQL into a SQLite file with structure only, then the data', async () => {
    const structure = await transfer(mysqlShop, file, SHOP, { content: 'structure' });
    expect(structure.tables.every((table) => table.created && table.rows === 0)).toBe(true);
    expect(await count(file, 'orders')).toBe(0);
    const data = await transfer(mysqlShop, file, SHOP, { content: 'data' });
    for (const table of data.tables) {
      expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
    }
    for (const table of SHOP) {
      expect(await count(file, table), table).toBe(await count(mysqlShop, table));
    }
  });

  it('copies the SQLite file on to PostgreSQL', async () => {
    await emptyPostgres(back);
    const report = await transfer(file, back, SHOP);
    for (const table of report.tables) {
      expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
    }
    expect(await emails(back)).toEqual(await emails(mysqlShop));
  });

  it('says a table is missing when only data is copied', async () => {
    const report = await transfer(mysqlShop, sqliteEnd('blank.db'), ['customers'], {
      content: 'data',
    });
    expect(report.tables[0]).toMatchObject({ outcome: 'failed' });
    expect(report.tables[0]?.error).toMatch(/does not exist/u);
  });
});

describe('between servers of one kind', () => {
  afterAll(async () => {
    await emptyMysql(mariadbEmpty);
  });

  it('copies MySQL to MariaDB keeping the types as they are', async () => {
    await emptyMysql(mariadbEmpty);
    const report = await transfer(mysqlShop, mariadbEmpty, [...SHOP, 'big_table']);
    for (const table of report.tables) {
      expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
    }
    expect(await count(mariadbEmpty, 'big_table')).toBe(10_000);
  });

  it('stops when cancelled', async () => {
    const abort = new AbortController();
    const report = await transfer(mysqlShop, mariadbEmpty, ['big_table'], {
      signal: abort.signal,
      onProgress: (progress) => {
        if (progress.rows > 0) {
          abort.abort();
        }
      },
    });
    expect(report.outcome).toBe('cancelled');
  });
});
