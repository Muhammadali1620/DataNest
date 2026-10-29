// Back-pressure of execute() (V5.2): a consumer slower than the server keeps the
// server waiting instead of piling rows up in memory, and stopping, cancelling or
// breaking off while the stream is paused leaves the session ready for more.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

const ROWS = 300_000;

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-flow-'));
});

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface Target {
  readonly label: string;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
  /** ROWS rows of about 200 bytes, numbered from 1 in the first column, in order. */
  readonly bigQuery: string;
  /** How many statements carrying `marker` the server is running right now. */
  readonly running?: (session: Session, marker: string) => Promise<number>;
}

function server(id: TestDatabaseId, driver: Driver): Pick<Target, 'label' | 'driver' | 'config'> {
  return {
    label: id,
    driver: () => driver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `flow-${id}`,
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

const MYSQL_BIG = `SELECT /* flow_probe */ (b.id - 1) * 10000 + a.id AS n, REPEAT('x', 200) AS pad
  FROM big_table a JOIN big_table b ON b.id <= ${ROWS / 10_000} ORDER BY b.id, a.id`;

async function mysqlRunning(session: Session, marker: string): Promise<number> {
  const rows = firstColumn(
    await runAll(
      session,
      `SELECT COUNT(*) FROM information_schema.PROCESSLIST
       WHERE INFO LIKE '%${marker}%' AND INFO NOT LIKE '%PROCESSLIST%'`,
    ),
  );
  return Number(rows[0]);
}

const TARGETS: readonly Target[] = [
  { ...server('mysql', mysqlDriver), bigQuery: MYSQL_BIG, running: mysqlRunning },
  { ...server('mariadb', mysqlDriver), bigQuery: MYSQL_BIG, running: mysqlRunning },
  {
    ...server('postgres', postgresDriver),
    bigQuery: `SELECT /* flow_probe */ g AS n, repeat('x', 200) AS pad FROM generate_series(1, ${ROWS}) g`,
    running: async (session, marker) => {
      const rows = firstColumn(
        await runAll(
          session,
          `SELECT count(*)::int FROM pg_stat_activity
           WHERE query LIKE '%${marker}%' AND state = 'active' AND pid <> pg_backend_pid()`,
        ),
      );
      return Number(rows[0]);
    },
  },
  {
    label: 'sqlite',
    driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
    config: () => ({
      id: 'flow-sqlite',
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'f.db'),
    }),
    bigQuery: `WITH RECURSIVE g(n) AS (SELECT 1 UNION ALL SELECT n + 1 FROM g WHERE n < ${ROWS})
      SELECT n, substr(hex(zeroblob(100)), 1, 200) AS pad FROM g`,
  },
];

describe.each(TARGETS)('$label', (target) => {
  let session: Session;
  let observer: Session | undefined;

  beforeAll(async () => {
    session = await target.driver().openSession(target.config());
    if (target.running !== undefined) {
      observer = await target.driver().openSession(target.config());
    }
  });

  afterAll(async () => {
    await session.close();
    await observer?.close();
  });

  it('hands every row, in order, to a consumer that stops to think', async () => {
    let expected = 1;
    let batches = 0;
    for await (const event of session.execute(target.bigQuery)) {
      if (event.kind !== 'rows') {
        continue;
      }
      for (const row of event.rows) {
        expect(Number(row[0])).toBe(expected);
        expected += 1;
      }
      batches += 1;
      if (batches % 100 === 0) {
        await sleep(5);
      }
    }
    expect(expected - 1).toBe(ROWS);
  });

  it.runIf(target.running !== undefined)(
    'keeps the server waiting while the consumer does not read',
    async () => {
      const iterator = session.execute(target.bigQuery)[Symbol.asyncIterator]();
      await iterator.next();
      await sleep(1500);
      // Without back-pressure the whole result would be read by now.
      if (observer === undefined) {
        throw new Error('The observer session is not open');
      }
      expect(await target.running?.(observer, 'flow_probe')).toBe(1);
      await iterator.return?.();
      expect(firstColumn(await runAll(session, 'SELECT 1'))).toEqual([1]);
    },
  );

  it('stays usable after the consumer breaks off a paused stream', async () => {
    let seen = 0;
    for await (const event of session.execute(target.bigQuery)) {
      if (event.kind === 'rows') {
        seen += event.rows.length;
        await sleep(200);
        break;
      }
    }
    expect(seen).toBeGreaterThan(0);
    expect(firstColumn(await runAll(session, 'SELECT 2'))).toEqual([2]);
  });

  it('cancels a paused statement and goes on with the next', async () => {
    const iterator = session.execute(target.bigQuery)[Symbol.asyncIterator]();
    await iterator.next();
    await sleep(300);
    const rest = (async () => {
      for (let step = await iterator.next(); step.done !== true; step = await iterator.next()) {
        // Drain whatever arrived before the cancel took hold.
      }
    })();
    const cancelled = expect(rest).rejects.toMatchObject({ code: 'cancelled' });
    await session.cancel();
    await cancelled;
    expect(firstColumn(await runAll(session, 'SELECT 3'))).toEqual([3]);
  });
});
