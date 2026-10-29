// Dumps of SQL Server (V5.2 on V6.2), checked the way the others are: the script is
// run on an empty database, everything must come back, and a second run over itself
// must work too.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/mssql';
import type { SessionTarget } from '../../../src/services/connection-manager';
import { type ScriptChunk, ScriptRunner } from '../../../src/services/script-runner';
import { SqlDumper } from '../../../src/services/sql-dump';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';

const RESTORE = 'datanest_restore';

function config(database?: string): ResolvedConnectionConfig {
  const db = testDatabase('mssql');
  return {
    id: 'dump-mssql',
    name: 'mssql',
    driver: 'mssql',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: database ?? db.database,
  };
}

function manager(): ConstructorParameters<typeof SqlDumper>[0]['manager'] {
  const sessions = new Map<string, Session>();
  return {
    driverOf: () => Promise.resolve(driver),
    acquire: async (owner: string, target: SessionTarget) => {
      const session = await driver.openSession(config(target.database));
      sessions.set(owner, session);
      return session;
    },
    release: async (owner: string) => {
      await sessions.get(owner)?.close();
      sessions.delete(owner);
    },
  };
}

async function use<T>(database: string | undefined, run: (session: Session) => Promise<T>) {
  const session = await driver.openSession(config(database));
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

async function dump(schema: string, options: { dropFirst?: boolean } = {}): Promise<string> {
  const scope = { schema };
  const relations = await use(undefined, async (session) => session.metadata.listTables(scope));
  let script = '';
  await new SqlDumper({ manager: manager(), logger: new RecordingLogger() }).dump({
    target: { connectionId: 'c' },
    scope,
    relations,
    wholeScope: true,
    content: 'all',
    dropFirst: options.dropFirst ?? true,
    sink: {
      write: (text: string) => {
        script += text;
        return Promise.resolve();
      },
    },
    source: 'test',
  });
  return script;
}

async function* parts(text: string): AsyncGenerator<ScriptChunk> {
  for (let offset = 0; offset < text.length; offset += 4096) {
    await Promise.resolve();
    const piece = text.slice(offset, offset + 4096);
    yield { text: piece, bytes: piece.length };
  }
}

async function restore(script: string): Promise<void> {
  const report = await new ScriptRunner({ manager: manager(), logger: new RecordingLogger() }).run({
    target: { connectionId: 'c', database: RESTORE },
    chunks: parts(script),
    continueOnError: false,
  });
  expect(report.stoppedAt, JSON.stringify(report.stoppedAt)).toBeUndefined();
  expect(report.failedCount).toBe(0);
}

async function rowsOf(database: string | undefined, table: string): Promise<string[]> {
  return await use(database, async (session) =>
    (await runAll(session, `SELECT * FROM ${table}`)).rows.map((row) => JSON.stringify(row)).sort(),
  );
}

describe('dumps of SQL Server', () => {
  let dbo = '';

  beforeAll(async () => {
    await use('master', async (session) => {
      await runAll(session, `DROP DATABASE IF EXISTS ${RESTORE}`);
      await runAll(session, `CREATE DATABASE ${RESTORE}`);
    });
    dbo = await dump('dbo');
  });

  afterAll(async () => {
    await use('master', async (session) => {
      await runAll(session, `ALTER DATABASE ${RESTORE} SET SINGLE_USER WITH ROLLBACK IMMEDIATE`);
      await runAll(session, `DROP DATABASE IF EXISTS ${RESTORE}`);
    });
  });

  it('writes every statement in a batch of its own, as sqlcmd reads it', () => {
    expect(dbo).toContain('\nGO\n');
    expect(dbo).toMatch(/SET IDENTITY_INSERT \[dbo\]\.\[customers\] ON;\nINSERT INTO/u);
    expect(dbo).toContain('DROP TABLE IF EXISTS');
    expect(dbo).not.toMatch(/CONSTRAINT \[(PK|DF|FK)__/u);
  });

  it('restores dbo on an empty database with the same rows and objects', async () => {
    await restore(dbo);
    for (const table of [
      'customers',
      'products',
      'orders',
      'order_items',
      'all_types',
      'big_table',
    ]) {
      expect(await rowsOf(RESTORE, table), table).toEqual(await rowsOf(undefined, table));
    }
    await use(RESTORE, async (session) => {
      expect(firstColumn(await runAll(session, 'SELECT dbo.order_total(1)'))).toEqual([
        { kind: 'decimal', text: '88.99' },
      ]);
      expect(firstColumn(await runAll(session, 'SELECT COUNT(*) FROM order_totals'))).toEqual([8]);
      expect(
        firstColumn(await runAll(session, 'SELECT NEXT VALUE FOR invoice_number_seq')),
      ).toEqual([1000]);
      // The trigger came back after the rows, and it works.
      await expect(
        runAll(session, 'INSERT INTO order_items VALUES (3, 1, 0, 1)'),
      ).rejects.toMatchObject({ code: 'constraint' });
      // Identity numbering goes on after the copied ids.
      await runAll(session, "INSERT INTO customers (email) VALUES (N'new@example.com')");
      expect(
        firstColumn(
          await runAll(session, "SELECT id FROM customers WHERE email = N'new@example.com'"),
        ),
      ).toEqual([6]);
      const description = await session.metadata.describeTable({
        schema: 'dbo',
        name: 'customers',
      });
      expect(description.comment).toBe('Shop customers');
      await expect(
        runAll(session, "INSERT INTO orders (customer_id, ordered_at) VALUES (999, '2024-01-01')"),
      ).rejects.toMatchObject({ code: 'constraint', driverCode: 547 });
    });
  });

  it('runs again over what it made', async () => {
    await restore(dbo);
    expect(await rowsOf(RESTORE, 'orders')).toEqual(await rowsOf(undefined, 'orders'));
  });

  it('restores another schema into a database that does not have it yet', async () => {
    await restore(await dump('inventory'));
    expect(await rowsOf(RESTORE, 'inventory.stock_levels')).toEqual(
      await rowsOf(undefined, 'inventory.stock_levels'),
    );
  });
});
