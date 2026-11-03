// Hostile text through the real servers: a literal the dialect writes must be read back
// by the server as exactly the text it came from, and a quoted name must come back as
// the column's name. Seeded, so a failure replays (V14.3).

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Dialect, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import { cellText } from '../../../src/shared/cell-text';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { pieces, seeded } from '../../helpers/fuzz';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

const PARTS = [
  "'",
  "''",
  '"',
  '`',
  '\\',
  '\\\\',
  "\\'",
  ';',
  '--',
  '/*',
  '*/',
  '%',
  '_',
  '?',
  ':x',
  '$1',
  '\n',
  '\r\n',
  '\t',
  ' ',
  'DROP TABLE t',
  "'; DROP TABLE t; --",
  'a',
  'é',
  '日本',
  '\u{1F600}',
  ' ',
  '0',
  'NULL',
];

function serverConfig(id: TestDatabaseId, driver: 'mysql' | 'postgres'): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `roundtrip-${id}`,
    name: `roundtrip ${id}`,
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
  readonly dialect: Dialect;
  open(): Promise<Session>;
}

describe('hostile text through real servers', () => {
  let worker: BuiltWorker;
  let dir: string;
  const open: Session[] = [];

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-roundtrip-'));
  }, 60_000);

  afterAll(async () => {
    for (const session of open) {
      await session.close();
    }
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  function targets(): Target[] {
    return [
      {
        label: 'mysql',
        dialect: mysqlDialect,
        open: () => mysqlDriver.openSession(serverConfig('mysql', 'mysql')),
      },
      {
        label: 'mariadb',
        dialect: mysqlDialect,
        open: () => mysqlDriver.openSession(serverConfig('mariadb', 'mysql')),
      },
      {
        label: 'postgres',
        dialect: postgresDialect,
        open: () => postgresDriver.openSession(serverConfig('postgres', 'postgres')),
      },
      {
        label: 'sqlite',
        dialect: sqliteDialect,
        open: () =>
          createSqliteDriver({ workerPath: worker.workerPath }).openSession({
            id: 'roundtrip-sqlite',
            name: 'roundtrip sqlite',
            driver: 'sqlite',
            file: join(dir, 'roundtrip.db'),
          }),
      },
    ];
  }

  it.each(targets().map((target) => [target.label, target] as const))(
    'reads back a text literal exactly on %s',
    async (label, target) => {
      const session = await target.open();
      open.push(session);
      const random = seeded(8000 + label.length * 31);
      for (let round = 0; round < 150; round += 1) {
        const text = pieces(random, PARTS, 10);
        const result = await runAll(session, `SELECT ${target.dialect.literal(text)}`);
        const cell = result.rows[0]?.[0];
        expect(
          cell === undefined ? undefined : cellText(cell),
          `${label} ${JSON.stringify(text)}`,
        ).toBe(text);
      }
    },
    120_000,
  );

  it.each(targets().map((target) => [target.label, target] as const))(
    'names a column exactly as the quoted identifier says on %s',
    async (label, target) => {
      const session = await target.open();
      open.push(session);
      const random = seeded(9000 + label.length * 17);
      for (let round = 0; round < 100; round += 1) {
        // A name the server accepts: not empty, no NUL; PostgreSQL and MySQL cap its length.
        const name = `c${pieces(random, PARTS, 6)}`;
        // MySQL names take only the first plane of Unicode (utf8mb3): no emoji in a name.
        if (
          name.length > 60 ||
          (label !== 'postgres' && label !== 'sqlite' && /[\u{10000}-\u{10FFFF}]/u.test(name))
        ) {
          continue;
        }
        const result = await runAll(session, `SELECT 1 AS ${target.dialect.quoteIdentifier(name)}`);
        expect(result.columnSets[0]?.[0]?.name, `${label} ${JSON.stringify(name)}`).toBe(name);
      }
    },
    120_000,
  );
});
