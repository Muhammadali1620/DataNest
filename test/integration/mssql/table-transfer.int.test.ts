// Copying tables to and from SQL Server (V5.6 on V6.2). The shop goes from SQL Server to
// a SQLite file and back into an empty SQL Server database, with keys, numbering and
// every value of the type-rich table; SQLite needs no server, so the group stays alone.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectScope } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { SessionTarget } from '../../../src/services/connection-manager';
import {
  type TransferReport,
  type TransferRequest,
  TableTransferService,
} from '../../../src/services/transfer/table-transfer';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-mssql-transfer-'));
});

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface End {
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  readonly scope: ObjectScope;
  readonly name: (table: string) => string;
}

function mssql(database: string): End {
  return {
    driver: () => mssqlDriver,
    config: () => {
      const db = testDatabase('mssql');
      return {
        id: `tr-mssql-${database}`,
        name: 'mssql',
        driver: 'mssql',
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database,
      };
    },
    scope: { database, schema: 'dbo' },
    name: (table) => `dbo.${table}`,
  };
}

function sqliteEnd(file: string): End {
  return {
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
  const ends = new Map([
    ['from', from],
    ['to', to],
  ]);
  const sessions = new Map<string, Session>();
  return await new TableTransferService({
    manager: {
      driverOf: (connectionId) => Promise.resolve((ends.get(connectionId) ?? from).driver()),
      acquire: async (owner, target: SessionTarget) => {
        const end = ends.get(target.connectionId) ?? from;
        const session = await end.driver().openSession(end.config());
        sessions.set(owner, session);
        return session;
      },
      release: async (owner) => {
        await sessions.get(owner)?.close();
      },
    },
    logger: new RecordingLogger(),
  }).transfer({
    source: { target: { connectionId: 'from' }, scope: from.scope },
    destination: { target: { connectionId: 'to' }, scope: to.scope },
    tables,
    content: 'all',
    existing: 'replace',
    ...overrides,
  });
}

async function rows(
  end: End,
  sql: (name: (table: string) => string) => string,
): Promise<unknown[]> {
  return await use(end, async (session) => (await runAll(session, sql(end.name))).rows);
}

function expectCopied(report: TransferReport): void {
  for (const table of report.tables) {
    expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
    expect(table.outcome).toBe('copied');
  }
}

async function emptyDbo(end: End): Promise<void> {
  await use(end, async (session) => {
    const tables = await session.metadata.listTables(end.scope);
    for (const table of tables) {
      for (const key of await session.metadata.listForeignKeys({
        schema: 'dbo',
        name: table.name,
      })) {
        await runAll(session, `ALTER TABLE dbo.[${table.name}] DROP CONSTRAINT [${key.name}]`);
      }
    }
    for (const table of tables) {
      await runAll(session, `DROP TABLE dbo.[${table.name}]`);
    }
  });
}

const SHOP = ['customers', 'products', 'orders', 'order_items'];
const shop = mssql('datanest_test');
const empty = mssql('datanest_empty');
const file = sqliteEnd('shop.db');

describe('SQL Server to SQLite and back', () => {
  beforeAll(async () => {
    await emptyDbo(empty);
  });

  afterAll(async () => {
    await emptyDbo(empty);
  });

  it('copies the shop and the type-rich table into a SQLite file', async () => {
    const report = await transfer(shop, file, [...SHOP, 'all_types', 'big_table']);
    expectCopied(report);
    expect(await rows(file, (n) => `SELECT COUNT(*) FROM ${n('big_table')}`)).toEqual([[10_000]]);
    const [typed] = await rows(
      file,
      (n) =>
        `SELECT c_bit, c_money, c_datetimeoffset, c_varbinary, c_nvarchar FROM ${n('all_types')} WHERE id = 1`,
    );
    // bit became a boolean (1); SQLite keeps NUMERIC as a number where it can.
    expect(typed).toEqual([
      1,
      922337203685477.6,
      expect.stringMatching(/^2024-06-15 /u),
      { kind: 'binary', size: 5, preview: 'cafebabe00' },
      'Многострочный\nтекст 🚀',
    ]);
  });

  it('copies the SQLite file into an empty SQL Server database with keys and numbering', async () => {
    const report = await transfer(file, empty, SHOP);
    expectCopied(report);
    expect(await rows(empty, (n) => `SELECT email FROM ${n('customers')} ORDER BY id`)).toEqual(
      await rows(shop, (n) => `SELECT email FROM ${n('customers')} ORDER BY id`),
    );
    await use(empty, async (session) => {
      await expect(
        runAll(
          session,
          "INSERT INTO dbo.orders (customer_id, ordered_at) VALUES (999, '2024-01-01')",
        ),
      ).rejects.toMatchObject({ code: 'constraint' });
      await runAll(session, "INSERT INTO dbo.customers (email) VALUES (N'new@example.com')");
      expect(
        firstColumn(
          await runAll(session, "SELECT id FROM dbo.customers WHERE email = N'new@example.com'"),
        ),
      ).toEqual([6]);
    });
  });
});

describe('SQL Server to SQL Server', () => {
  afterAll(async () => {
    await emptyDbo(empty);
  });

  it('copies between databases keeping the types as they are', async () => {
    await emptyDbo(empty);
    const report = await transfer(shop, empty, [...SHOP, 'all_types']);
    expectCopied(report);
    expect(await rows(empty, (n) => `SELECT * FROM ${n('all_types')} ORDER BY id`)).toEqual(
      await rows(shop, (n) => `SELECT * FROM ${n('all_types')} ORDER BY id`),
    );
    const columns = await use(empty, async (session) =>
      session.metadata.listColumns({ schema: 'dbo', name: 'all_types' }),
    );
    expect(columns.find((column) => column.name === 'c_datetimeoffset')?.dataType).toBe(
      'datetimeoffset(7)',
    );
  });

  it('adds rows to a table that is there', async () => {
    await use(empty, async (session) => {
      await runAll(session, 'DELETE FROM dbo.order_items');
    });
    const report = await transfer(shop, empty, ['order_items'], { existing: 'append' });
    expect(report.tables[0]).toMatchObject({ outcome: 'copied', created: false, rows: 12 });
  });
});
