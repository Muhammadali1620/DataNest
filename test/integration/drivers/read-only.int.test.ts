// Read-only connections against real servers (V4.6): the client already refuses
// changing statements, and here the session itself is shown to refuse them too, so a
// write hidden in a function or a procedure cannot get through either.

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
  /** A write that hides in a SELECT: the client cannot see it, the server must stop it. */
  readonly sneakyWrite?: string;
}

let worker: BuiltWorker;
let dir: string;

function server(id: TestDatabaseId, driver: Driver): Pick<Target, 'driver' | 'config'> {
  return {
    driver: () => driver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `ro-${id}`,
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
  { label: 'mysql', ...server('mysql', mysqlDriver) },
  { label: 'mariadb', ...server('mariadb', mysqlDriver) },
  {
    label: 'postgres',
    ...server('postgres', postgresDriver),
    sneakyWrite: "SELECT nextval('ro_probe_seq')",
  },
  {
    label: 'sqlite',
    driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
    config: () => ({ id: 'ro-sqlite', name: 'sqlite', driver: 'sqlite', file: join(dir, 'ro.db') }),
  },
];

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-ro-'));
});

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe.each(TARGETS)('read-only session on $label', (target) => {
  let writer: Session;

  beforeAll(async () => {
    writer = await target.driver().openSession(target.config());
    await run(writer, 'DROP TABLE IF EXISTS ro_probe');
    await run(writer, 'CREATE TABLE ro_probe (id INTEGER PRIMARY KEY)');
    await run(writer, 'INSERT INTO ro_probe (id) VALUES (1)');
    if (target.sneakyWrite !== undefined) {
      await run(writer, 'DROP SEQUENCE IF EXISTS ro_probe_seq');
      await run(writer, 'CREATE SEQUENCE ro_probe_seq');
    }
  });

  afterAll(async () => {
    await run(writer, 'DROP TABLE IF EXISTS ro_probe');
    if (target.sneakyWrite !== undefined) {
      await run(writer, 'DROP SEQUENCE IF EXISTS ro_probe_seq');
    }
    await writer.close();
  });

  it('reads as usual', async () => {
    const session = await target.driver().openSession({ ...target.config(), readOnly: true });
    try {
      expect(await run(session, 'SELECT id FROM ro_probe')).toEqual([[1]]);
    } finally {
      await session.close();
    }
  });

  it('is refused every write by the server itself', async () => {
    const session = await target.driver().openSession({ ...target.config(), readOnly: true });
    try {
      await expect(run(session, 'INSERT INTO ro_probe (id) VALUES (2)')).rejects.toThrow();
      await expect(run(session, 'UPDATE ro_probe SET id = 3')).rejects.toThrow();
      await expect(run(session, 'DELETE FROM ro_probe')).rejects.toThrow();
      if (target.sneakyWrite !== undefined) {
        await expect(run(session, target.sneakyWrite)).rejects.toThrow(/read-only/i);
      }
      expect(await run(writer, 'SELECT id FROM ro_probe')).toEqual([[1]]);
    } finally {
      await session.close();
    }
  });

  it('leaves sessions without the flag writable', async () => {
    await run(writer, 'INSERT INTO ro_probe (id) VALUES (5)');
    await run(writer, 'DELETE FROM ro_probe WHERE id = 5');
  });
});
