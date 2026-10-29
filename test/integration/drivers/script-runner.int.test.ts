// Running SQL files on real servers (V5.1): dump-style scripts read in tiny parts,
// so every DELIMITER, body, string and COPY block crosses a part boundary somewhere.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { type ScriptReport, ScriptRunner } from '../../../src/services/script-runner';
import { readTextChunks } from '../../../src/services/text-file';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-script-'));
});

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

interface Target {
  readonly label: string;
  readonly driverId: DriverId;
  readonly driver: () => Driver;
  readonly config: () => ResolvedConnectionConfig;
}

function server(id: TestDatabaseId, driver: Driver): Target {
  return {
    label: id,
    driverId: id === 'postgres' ? 'postgres' : 'mysql',
    driver: () => driver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `script-${id}`,
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

const SQLITE: Target = {
  label: 'sqlite',
  driverId: 'sqlite',
  driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
  config: () => ({
    id: 'script-sqlite',
    name: 'sqlite',
    driver: 'sqlite',
    file: join(dir, 's.db'),
  }),
};

/** Runs a script file through ScriptRunner with real sessions, read 37 bytes at a time. */
async function runScript(
  target: Target,
  sql: string,
  continueOnError: boolean,
): Promise<{ report: ScriptReport; closed: number }> {
  const file = join(dir, `${target.label}-${Date.now()}.sql`);
  writeFileSync(file, sql);
  const driver = target.driver();
  const sessions = new Map<string, Session>();
  let closed = 0;
  const runner = new ScriptRunner({
    manager: {
      driverOf: () => Promise.resolve(driver),
      acquire: async (owner) => {
        const session = await driver.openSession(target.config());
        sessions.set(owner, session);
        return session;
      },
      release: async (owner) => {
        await sessions.get(owner)?.close();
        closed += 1;
      },
    },
    logger: new RecordingLogger(),
  });
  const report = await runner.run({
    target: { connectionId: target.config().id },
    chunks: readTextChunks(file, 37),
    continueOnError,
  });
  return { report, closed };
}

async function withSession<T>(target: Target, use: (session: Session) => Promise<T>): Promise<T> {
  const session = await target.driver().openSession(target.config());
  try {
    return await use(session);
  } finally {
    await session.close();
  }
}

async function ids(target: Target, table: string): Promise<unknown[]> {
  return await withSession(target, async (session) =>
    firstColumn(await runAll(session, `SELECT id FROM ${table} ORDER BY id`)),
  );
}

const MYSQL_DUMP = `-- MySQL dump of a test
/*!40101 SET NAMES utf8mb4 */;
/*!40014 SET @OLD_FK=@@FOREIGN_KEY_CHECKS, FOREIGN_KEY_CHECKS=0 */;
DROP TABLE IF EXISTS script_child;
DROP TABLE IF EXISTS script_items;
-- Accepted only while FOREIGN_KEY_CHECKS is 0: the parent does not exist yet.
CREATE TABLE script_child (id INT PRIMARY KEY, item_id INT,
  CONSTRAINT fk_script_child FOREIGN KEY (item_id) REFERENCES script_items (id));
CREATE TABLE script_items (id INT PRIMARY KEY, name VARCHAR(50));
INSERT INTO script_items VALUES (1, 'a;b'), (2, 'it''s \\'quoted\\'; really');
DROP PROCEDURE IF EXISTS script_fill;
DELIMITER //
CREATE PROCEDURE script_fill()
BEGIN
  INSERT INTO script_items VALUES (3, 'from; the procedure');
  INSERT INTO script_items VALUES (4, 'x');
END//
DELIMITER ;
CALL script_fill();
SELECT * FROM script_items;
/*!40014 SET FOREIGN_KEY_CHECKS=@OLD_FK */;
`;

describe.each([server('mysql', mysqlDriver), server('mariadb', mysqlDriver)])(
  '$label',
  (target) => {
    afterAll(async () => {
      await withSession(target, async (session) => {
        await runAll(session, 'DROP TABLE IF EXISTS script_child, script_items');
        await runAll(session, 'DROP PROCEDURE IF EXISTS script_fill');
      });
    });

    it('runs a mysqldump-style file with DELIMITER and executable comments', async () => {
      const { report, closed } = await runScript(target, MYSQL_DUMP, false);
      expect(report).toMatchObject({ outcome: 'done', failedCount: 0, rolledBack: false });
      expect(report.statements).toBe(12);
      expect(closed).toBe(1);
      expect(await ids(target, 'script_items')).toEqual([1, 2, 3, 4]);
    });

    it('reports failures with their lines and goes on when asked', async () => {
      const sql =
        'DELETE FROM script_items;\nSELECT * FROM\n  no_such_table;\nINSERT INTO script_items VALUES (7, null);\n';
      const { report } = await runScript(target, sql, true);
      expect(report.failedCount).toBe(1);
      expect(report.failures[0]).toMatchObject({ kind: 'error', line: 2, code: 'not-found' });
      expect(await ids(target, 'script_items')).toEqual([7]);
    });

    it('rolls back a transaction the file never committed', async () => {
      const { report } = await runScript(
        target,
        'START TRANSACTION;\nINSERT INTO script_items VALUES (8, null);\n',
        false,
      );
      expect(report.rolledBack).toBe(true);
      expect(await ids(target, 'script_items')).toEqual([7]);
    });
  },
);

describe('postgres', () => {
  const target = server('postgres', postgresDriver);

  afterAll(async () => {
    await withSession(target, async (session) => {
      await runAll(session, 'DROP TABLE IF EXISTS script_items');
      await runAll(session, 'DROP FUNCTION IF EXISTS script_fill()');
    });
  });

  const dump = `--
-- PostgreSQL database dump
--
\\restrict Zq9
SET client_min_messages = warning;
SELECT pg_catalog.set_config('search_path', 'public', false);
DROP TABLE IF EXISTS script_items;
CREATE TABLE script_items (id int PRIMARY KEY, name text);
CREATE OR REPLACE FUNCTION script_fill() RETURNS void AS $body$
BEGIN
  INSERT INTO script_items VALUES (3, 'from; the function');
END;
$body$ LANGUAGE plpgsql;
INSERT INTO script_items VALUES (1, 'a;b'), (2, E'it\\'s; quoted');
COPY script_items (id, name) FROM stdin;
9\tO'Brien; DROP TABLE script_items;
10\t\\N
\\.
SELECT script_fill();
\\unrestrict Zq9
`;

  it('runs a pg_dump-style file, skipping COPY data and harmless psql commands', async () => {
    const { report } = await runScript(target, dump, true);
    expect(report.outcome).toBe('done');
    expect(report.failures).toEqual([
      {
        kind: 'copy-from-stdin',
        line: 15,
        statement: 'COPY script_items (id, name) FROM stdin',
      },
    ]);
    expect(report.skipped.map((item) => item.line)).toEqual([4, 20]);
    expect(report.statements).toBe(7);
    expect(await ids(target, 'script_items')).toEqual([1, 2, 3]);
  });

  it('stops at the first failure and leaves the rest unrun', async () => {
    const { report } = await runScript(
      target,
      'DELETE FROM script_items WHERE id = 1;\nSELECT 1/0;\nDELETE FROM script_items;\n',
      false,
    );
    expect(report.outcome).toBe('stopped');
    expect(report.stoppedAt).toMatchObject({ line: 2, statement: 'SELECT 1/0' });
    expect(await ids(target, 'script_items')).toEqual([2, 3]);
  });

  it('rolls back a transaction that a failure spoiled', async () => {
    const { report } = await runScript(
      target,
      'BEGIN;\nDELETE FROM script_items;\nSELECT broken syntax here;\n',
      true,
    );
    expect(report.rolledBack).toBe(true);
    expect(await ids(target, 'script_items')).toEqual([2, 3]);
  });
});

describe('sqlite', () => {
  it('runs a script with a trigger body and an open transaction at the end', async () => {
    const sql = `CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT);
CREATE TABLE log (item_id INTEGER);
CREATE TRIGGER items_log AFTER INSERT ON items BEGIN
  INSERT INTO log VALUES (new.id);
  UPDATE items SET name = name || ';' WHERE id = new.id;
END;
INSERT INTO items (id, name) VALUES (1, 'a'), (2, 'b');
BEGIN;
INSERT INTO items (id, name) VALUES (3, 'never committed');
`;
    const { report } = await runScript(SQLITE, sql, false);
    expect(report).toMatchObject({ outcome: 'done', statements: 6, rolledBack: true });
    expect(await ids(SQLITE, 'items')).toEqual([1, 2]);
    expect(await ids(SQLITE, '(SELECT item_id AS id FROM log)')).toEqual([1, 2]);
  });
});
