// Transaction state as real servers report it (V4.8): DataNest never guesses it from
// SQL, so each driver must read what the server says — PostgreSQL's ready-for-query
// status, MySQL's status flags, SQLite's own flag — and the result saver must join a
// transaction the user opened instead of committing it.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

async function run(session: Session, sql: string): Promise<unknown[][]> {
  const rows: unknown[][] = [];
  for await (const event of session.execute(sql)) {
    if (event.kind === 'rows') {
      rows.push(...event.rows.map((row) => [...row]));
    }
  }
  return rows;
}

interface Target {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  /** PostgreSQL spoils a transaction on any error; the others keep it usable. */
  readonly failsOnError: boolean;
  /** MySQL commits by itself before DDL. */
  readonly ddlCommits: boolean;
}

let worker: BuiltWorker;
let dir: string;

function server(id: TestDatabaseId, driver: Driver): Pick<Target, 'driver' | 'config'> {
  return {
    driver: () => driver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `tx-${id}`,
        name: id,
        driver: id === 'postgres' ? 'postgres' : 'mysql',
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
      };
    },
  };
}

const TARGETS: readonly Target[] = [
  { label: 'mysql', ...server('mysql', mysqlDriver), failsOnError: false, ddlCommits: true },
  { label: 'mariadb', ...server('mariadb', mysqlDriver), failsOnError: false, ddlCommits: true },
  {
    label: 'postgres',
    ...server('postgres', postgresDriver),
    failsOnError: true,
    ddlCommits: false,
  },
  {
    label: 'sqlite',
    driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
    config: () => ({ id: 'tx-sqlite', name: 'sqlite', driver: 'sqlite', file: join(dir, 'tx.db') }),
    failsOnError: false,
    ddlCommits: false,
  },
];

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-tx-'));
});

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(TARGETS)('transaction state on $label', (target) => {
  let session: Session;
  let other: Session;

  beforeAll(async () => {
    session = await target.driver().openSession(target.config());
    other = await target.driver().openSession(target.config());
    await run(session, 'DROP TABLE IF EXISTS tx_probe');
    await run(session, 'CREATE TABLE tx_probe (id INTEGER PRIMARY KEY)');
  });

  afterAll(async () => {
    await run(session, 'ROLLBACK').catch(() => undefined);
    await run(session, 'DROP TABLE IF EXISTS tx_probe');
    await session.close();
    await other.close();
  });

  it('starts idle and stays idle after statements that commit on their own', async () => {
    expect(session.transactionState?.()).toBe('idle');
    await run(session, 'INSERT INTO tx_probe (id) VALUES (1)');
    await run(session, 'SELECT * FROM tx_probe');
    expect(session.transactionState?.()).toBe('idle');
  });

  it('is open from BEGIN through reads and writes, and idle after COMMIT', async () => {
    await run(session, 'BEGIN');
    expect(session.transactionState?.()).toBe('open');
    await run(session, 'INSERT INTO tx_probe (id) VALUES (2)');
    await run(session, 'SELECT * FROM tx_probe');
    expect(session.transactionState?.()).toBe('open');
    await run(session, 'COMMIT');
    expect(session.transactionState?.()).toBe('idle');
    expect(await run(other, 'SELECT id FROM tx_probe WHERE id = 2')).toHaveLength(1);
  });

  it('keeps uncommitted rows from other sessions and drops them on ROLLBACK', async () => {
    await run(session, 'BEGIN');
    await run(session, 'INSERT INTO tx_probe (id) VALUES (3)');
    if (target.label !== 'sqlite') {
      // SQLite's other connection would wait for the writer's lock instead.
      expect(await run(other, 'SELECT id FROM tx_probe WHERE id = 3')).toHaveLength(0);
    }
    await run(session, 'ROLLBACK');
    expect(session.transactionState?.()).toBe('idle');
    expect(await run(session, 'SELECT id FROM tx_probe WHERE id = 3')).toHaveLength(0);
  });

  it('reports what an error inside a transaction leaves behind', async () => {
    await run(session, 'BEGIN');
    await expect(run(session, 'INSERT INTO tx_probe (id) VALUES (1)')).rejects.toThrow();
    expect(session.transactionState?.()).toBe(target.failsOnError ? 'failed' : 'open');
    await run(session, 'ROLLBACK');
    expect(session.transactionState?.()).toBe('idle');
  });

  it('keeps a transaction open through a savepoint and its rollback', async () => {
    await run(session, 'BEGIN');
    await run(session, 'SAVEPOINT datanest_save');
    await run(session, 'INSERT INTO tx_probe (id) VALUES (4)');
    await run(session, 'ROLLBACK TO SAVEPOINT datanest_save');
    expect(session.transactionState?.()).toBe('open');
    await run(session, 'COMMIT');
    expect(await run(session, 'SELECT id FROM tx_probe WHERE id = 4')).toHaveLength(0);
  });

  it('keeps what a released savepoint fenced, as a grid save inside a transaction does', async () => {
    await run(session, 'BEGIN');
    await run(session, 'SAVEPOINT datanest_save');
    await run(session, 'INSERT INTO tx_probe (id) VALUES (6)');
    await run(session, 'RELEASE SAVEPOINT datanest_save');
    expect(session.transactionState?.()).toBe('open');
    await run(session, 'ROLLBACK');
    // The user's rollback still undoes it: the save joined their transaction.
    expect(await run(session, 'SELECT id FROM tx_probe WHERE id = 6')).toHaveLength(0);
  });

  it(
    target.ddlCommits
      ? 'sees MySQL commit the transaction before DDL'
      : 'keeps DDL inside the transaction',
    async () => {
      await run(session, 'BEGIN');
      await run(session, 'INSERT INTO tx_probe (id) VALUES (5)');
      await run(session, 'CREATE TABLE tx_probe_ddl (id INTEGER)');
      expect(session.transactionState?.()).toBe(target.ddlCommits ? 'idle' : 'open');
      await run(session, 'ROLLBACK');
      // MySQL's implicit commit kept the row; the others rolled both back.
      expect(await run(session, 'SELECT id FROM tx_probe WHERE id = 5')).toHaveLength(
        target.ddlCommits ? 1 : 0,
      );
      await run(session, 'DROP TABLE IF EXISTS tx_probe_ddl');
    },
  );
});

describe('SQLite cancel', () => {
  it('forgets the transaction of the worker it abandons', async () => {
    const driver = createSqliteDriver({ workerPath: worker.workerPath });
    const session = await driver.openSession({
      id: 'tx-cancel',
      name: 'cancel',
      driver: 'sqlite',
      file: join(dir, 'cancel.db'),
    });
    try {
      await run(session, 'BEGIN');
      expect(session.transactionState?.()).toBe('open');
      const running = run(
        session,
        'WITH RECURSIVE n(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM n) SELECT count(*) FROM n',
      );
      const stopped = expect(running).rejects.toMatchObject({ code: 'cancelled' });
      await new Promise((resolve) => setTimeout(resolve, 100));
      await session.cancel();
      await stopped;
      expect(session.transactionState?.()).toBe('idle');
    } finally {
      await session.close();
    }
  });
});
