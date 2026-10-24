// One check across every driver: a value that cannot survive a JS number must come
// back with its exact text, and the shared serializer must reproduce that text.
// This is the promise of V1.18, so it is tested against the real servers.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cellJson, cellText } from '../../../src/shared/cell-text';
import type { CellValue } from '../../../src/shared/cell-value';
import type { Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

const BIG_INT = '9223372036854775807';
const BIG_DECIMAL = '12345678901234567890.0123456789';

function serverConfig(
  id: TestDatabaseId,
  driverId: 'mysql' | 'postgres',
): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `fidelity-${id}`,
    name: `fidelity ${id}`,
    driver: driverId,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

interface Target {
  readonly label: string;
  /** Opens a session when the test runs; the SQLite worker exists only by then. */
  open(): Promise<Session>;
  /** The query that returns a big int, a big decimal, a timestamp and 4 bytes. */
  readonly sql: string;
}

describe('value fidelity across drivers', () => {
  let worker: BuiltWorker;
  let dir: string;
  const open: Session[] = [];

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-fidelity-'));
  }, 60_000);

  afterAll(async () => {
    for (const session of open) {
      await session.close();
    }
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  // Built at collection time, so the labels are known; every `open` runs later.
  function targets(): Target[] {
    return [
      {
        label: 'mysql',
        open: () => mysqlDriver.openSession(serverConfig('mysql', 'mysql')),
        sql: `SELECT c_bigint, c_decimal, c_datetime, c_binary FROM all_types WHERE id = 1`,
      },
      {
        label: 'mariadb',
        open: () => mysqlDriver.openSession(serverConfig('mariadb', 'mysql')),
        sql: `SELECT c_bigint, c_decimal, c_datetime, c_binary FROM all_types WHERE id = 1`,
      },
      {
        label: 'postgres',
        open: () => postgresDriver.openSession(serverConfig('postgres', 'postgres')),
        sql: `SELECT c_bigint, c_numeric, c_timestamp, c_bytea FROM all_types WHERE id = 1`,
      },
      {
        label: 'sqlite',
        open: () =>
          createSqliteDriver({ workerPath: worker.workerPath }).openSession({
            id: 'fidelity-sqlite',
            name: 'fidelity sqlite',
            driver: 'sqlite',
            file: join(dir, 'fidelity.db'),
          }),
        sql: `SELECT ${BIG_INT}, '${BIG_DECIMAL}', '2024-12-31 23:59:59.123456', x'deadbeef'`,
      },
    ];
  }

  it.each(targets().map((target) => [target.label, target] as const))(
    'keeps precision on %s',
    async (_label, target) => {
      const session = await target.open();
      open.push(session);
      const result = await runAll(session, target.sql);
      const row = result.rows[0];
      if (row === undefined) {
        throw new Error('no row came back');
      }
      const [big, decimal, moment, binary] = row as [CellValue, CellValue, CellValue, CellValue];

      // A 64-bit integer is never squeezed into a double.
      expect(cellText(big)).toBe(BIG_INT);
      expect(Number.isSafeInteger(Number(cellText(big)))).toBe(false);

      // A 30-digit decimal keeps every digit. SQLite has no decimal type, so the
      // value arrives as the text it was given.
      expect(cellText(decimal)).toBe(BIG_DECIMAL);

      // The timestamp keeps the server's own spelling, down to microseconds.
      expect(cellText(moment)).toContain('2024-12-31 23:59:59.123456');

      // Binary is hex, and these four bytes travelled whole.
      expect(cellText(binary)).toBe('0xdeadbeef');

      // What JSON export writes is exactly what the server said.
      expect(cellJson(big)).toBe(BIG_INT);
      expect(cellJson(decimal)).toBe(BIG_DECIMAL);
    },
  );

  it('tags the kinds the same way on every server', async () => {
    const kinds = new Map<string, string[]>();
    for (const target of targets()) {
      const session = await target.open();
      open.push(session);
      const result = await runAll(session, target.sql);
      const row = result.rows[0] ?? [];
      kinds.set(
        target.label,
        row.map((value) =>
          value === null ? 'null' : typeof value === 'object' ? value.kind : typeof value,
        ),
      );
    }
    // bigint and binary are tagged everywhere; decimal is a real type only on the
    // servers that have one, and SQLite returns the text it was given.
    for (const [label, row] of kinds) {
      expect(row[0], label).toBe('bigint');
      expect(row[3], label).toBe('binary');
      expect(['decimal', 'string'], label).toContain(row[1]);
      expect(['datetime', 'string'], label).toContain(row[2]);
    }
    expect(kinds.get('mysql')?.[1]).toBe('decimal');
    expect(kinds.get('postgres')?.[1]).toBe('decimal');
    expect(kinds.get('mysql')?.[2]).toBe('datetime');
  });

  it('round-trips NULL from every server as null', async () => {
    for (const target of targets()) {
      const session = await target.open();
      open.push(session);
      const result = await runAll(session, 'SELECT NULL');
      expect(result.rows[0]?.[0], target.label).toBeNull();
      expect(cellText(result.rows[0]?.[0] ?? null)).toBe('');
      expect(cellText(result.rows[0]?.[0] ?? null, { nullText: 'NULL' })).toBe('NULL');
    }
  });
});
