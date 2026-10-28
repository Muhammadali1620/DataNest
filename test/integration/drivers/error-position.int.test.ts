// The errors real servers give for broken statements, and where the editor marks
// them: from the driver's own position (PostgreSQL) or from the message.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { guessErrorPosition } from '../../../src/core/sql/error-position';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { errorMarkers } from '../../../src/services/error-markers';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

function config(id: TestDatabaseId, driver: DriverId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `err-${id}`,
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

/** The marked text of a statement as the editor would show it. */
async function marked(session: Session, driver: DriverId, sql: string): Promise<string> {
  const error = await runAll(session, sql).then(
    () => undefined,
    (thrown: unknown) => thrown,
  );
  if (!(error instanceof DbError)) {
    throw new Error(`expected a DbError for ${sql}`);
  }
  const position = error.position ?? guessErrorPosition(error.message, sql, driver);
  const [marker] = errorMarkers(
    sql,
    [
      {
        statement: sql,
        statementStart: 0,
        error: {
          code: error.code,
          message: error.message,
          ...(position === undefined ? {} : { position }),
        },
      },
    ],
    driver,
  );
  return marker === undefined ? '' : sql.slice(marker.start, marker.end);
}

describe.each(['mysql', 'mariadb'] as const)('error positions on %s', (serverId) => {
  let session: Session;

  beforeAll(async () => {
    session = await mysqlDriver.openSession(config(serverId, 'mysql'));
  });

  afterAll(async () => {
    await session.close();
  });

  it('marks the word a syntax error is near, on the right line', async () => {
    expect(await marked(session, 'mysql', 'SELECT id,\n  email,\nFROM customers')).toBe('FROM');
  });

  it('marks an unknown column and an unknown table', async () => {
    expect(await marked(session, 'mysql', 'SELECT c.emial FROM customers c')).toBe('emial');
    expect(await marked(session, 'mysql', 'SELECT * FROM custmers')).toBe('custmers');
  });
});

describe('error positions on postgres', () => {
  let session: Session;

  beforeAll(async () => {
    session = await postgresDriver.openSession(config('postgres', 'postgres'));
  });

  afterAll(async () => {
    await session.close();
  });

  it('uses the position the server reports', async () => {
    expect(await marked(session, 'postgres', 'SELECT id,\nFROM customers')).toBe('FROM');
    expect(await marked(session, 'postgres', 'SELECT emial FROM customers')).toBe('emial');
    expect(await marked(session, 'postgres', 'SELECT * FROM custmers')).toBe('custmers');
  });
});

describe('error positions on sqlite', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let dir: string;
  let session: Session;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-errpos-'));
    session = await driver.openSession({
      id: 'err-sqlite',
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'err.db'),
    });
    await runAll(session, 'CREATE TABLE customers (id INTEGER PRIMARY KEY, email TEXT)');
  }, 60_000);

  afterAll(async () => {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  it('marks syntax errors and unknown names from the message', async () => {
    expect(await marked(session, 'sqlite', 'SELECT id,\nFROM customers')).toBe('FROM');
    expect(await marked(session, 'sqlite', 'SELECT emial FROM customers')).toBe('emial');
    expect(await marked(session, 'sqlite', 'SELECT * FROM custmers')).toBe('custmers');
  });

  it('marks the whole statement when the message says nothing about where', async () => {
    expect(await marked(session, 'sqlite', 'INSERT INTO customers VALUES (1, 2, 3)')).toBe(
      'INSERT INTO customers VALUES (1, 2, 3)',
    );
  });
});
