// Spatial columns of MySQL and MariaDB on real servers (V13.13): the grid shows them as
// text, and a dump or a transfer writes that text back as geometries (ST_GeomFromText),
// not as strings the server would refuse.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { wktToMysqlGeometry } from '../../../src/core/geo/wkb';
import type { Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import type { SessionTarget } from '../../../src/services/connection-manager';
import { type ScriptChunk, ScriptRunner } from '../../../src/services/script-runner';
import { SqlDumper } from '../../../src/services/sql-dump';
import { TableTransferService } from '../../../src/services/transfer/table-transfer';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';

const driver = mysqlDriver;

function configOf(id: TestDatabaseId, database: string): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `spatial-${id}-${database}`,
    name: id,
    driver: 'mysql',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database,
  };
}

async function use<T>(
  id: TestDatabaseId,
  database: string,
  run: (session: Session) => Promise<T>,
): Promise<T> {
  const session = await driver.openSession(configOf(id, database));
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

/** The manager of the services: every owner gets a session on the database its target names. */
function managerOf(id: TestDatabaseId, databases: Readonly<Record<string, string>>) {
  const sessions = new Map<string, Session>();
  return {
    driverOf: () => Promise.resolve(driver),
    acquire: async (owner: string, target: SessionTarget) => {
      const database = databases[target.connectionId] ?? target.database ?? 'datanest_empty';
      const session = await driver.openSession(configOf(id, database));
      sessions.set(owner, session);
      return session;
    },
    release: async (owner: string) => {
      await sessions.get(owner)?.close();
      sessions.delete(owner);
    },
  };
}

async function* parts(text: string): AsyncGenerator<ScriptChunk> {
  await Promise.resolve();
  yield { text, bytes: text.length };
}

/** What the server itself says about the rows, apart from how the driver shows them. */
const PROJECTION =
  'SELECT id, ST_AsText(place), ST_SRID(place), ST_AsText(area), ST_SRID(area), note ' +
  'FROM spatial_things ORDER BY id';

describe.each([
  { label: 'mysql', id: 'mysql' as const },
  { label: 'mariadb', id: 'mariadb' as const },
])('spatial columns of $label', ({ id }) => {
  const source = 'datanest_empty';
  const other = 'datanest_test';

  async function drop(database: string): Promise<void> {
    await use(id, database, (session) => runAll(session, 'DROP TABLE IF EXISTS spatial_things'));
  }

  beforeAll(async () => {
    await drop(source);
    await use(id, source, async (session) => {
      await runAll(
        session,
        'CREATE TABLE spatial_things (id INT PRIMARY KEY, place POINT NULL, area GEOMETRY NULL, note TEXT NULL)',
      );
      await runAll(
        session,
        `INSERT INTO spatial_things VALUES
          (1, ST_GeomFromText('POINT(1 2)', 3857), ST_GeomFromText('POLYGON((0 0, 4 0, 4 4, 0 4, 0 0))'),
           'SRID=4326;POINT(1 2)'),
          (2, NULL, ST_GeomFromText('MULTIPOINT(1 2, 3 4)', 3857), NULL),
          (3, ST_GeomFromText('POINT(0.1 -2.5)'),
           ST_GeomFromText('GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1))'), 'POINT(1 2)'),
          (4, ST_GeomFromText('POINT(10 20)', 4326), ST_GeomFromText('POINT(30 40)', 4326), NULL)`,
      );
    });
  });

  afterAll(async () => {
    await drop(source);
    await drop(other);
  });

  async function projection(database: string): Promise<unknown[][]> {
    return await use(id, database, async (session) => [
      ...(await runAll(session, PROJECTION)).rows.map((row) => [...row]),
    ]);
  }

  it('shows geometries as text and leaves a text column text', async () => {
    const result = await use(id, source, (session) =>
      runAll(session, 'SELECT id, place, area, note FROM spatial_things WHERE id < 4 ORDER BY id'),
    );
    expect(result.rows).toEqual([
      [1, 'SRID=3857;POINT(1 2)', 'POLYGON((0 0, 4 0, 4 4, 0 4, 0 0))', 'SRID=4326;POINT(1 2)'],
      [2, null, 'SRID=3857;MULTIPOINT((1 2), (3 4))', null],
      [3, 'POINT(0.1 -2.5)', 'GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1))', 'POINT(1 2)'],
    ]);
  });

  it('dumps the geometries as ST_GeomFromText and restores every one', async () => {
    const before = await projection(source);
    let script = '';
    await new SqlDumper({
      manager: managerOf(id, {}),
      logger: new RecordingLogger(),
    }).dump({
      target: { connectionId: 'c', database: source },
      scope: { database: source },
      relations: [{ name: 'spatial_things', kind: 'table' }],
      wholeScope: false,
      content: 'all',
      dropFirst: true,
      sink: {
        write: (text: string) => {
          script += text;
          return Promise.resolve();
        },
      },
      source: 'test',
    });
    // The value goes back in the form the server keeps it, with its SRID and axis order.
    for (const text of ['SRID=3857;POINT(1 2)', 'SRID=3857;MULTIPOINT((1 2), (3 4))']) {
      expect(script).toContain(`x'${Buffer.from(wktToMysqlGeometry(text) ?? []).toString('hex')}'`);
    }
    // The text column keeps its text, though it looks like a geometry.
    expect(script).toContain("'SRID=4326;POINT(1 2)'");
    expect(script).not.toContain('ST_GeomFromText');

    await use(id, source, (session) => runAll(session, 'DELETE FROM spatial_things'));
    const report = await new ScriptRunner({
      manager: managerOf(id, {}),
      logger: new RecordingLogger(),
    }).run({
      target: { connectionId: 'c', database: source },
      chunks: parts(script),
      continueOnError: false,
    });
    expect(report.stoppedAt, JSON.stringify(report.stoppedAt)).toBeUndefined();
    expect(report.failedCount).toBe(0);
    expect(await projection(source)).toEqual(before);
  });

  it('copies the table to another database with its geometries', async () => {
    const before = await projection(source);
    await drop(other);
    const report = await new TableTransferService({
      manager: managerOf(id, { from: source, to: other }),
      logger: new RecordingLogger(),
    }).transfer({
      source: { target: { connectionId: 'from' }, scope: { database: source } },
      destination: { target: { connectionId: 'to' }, scope: { database: other } },
      tables: ['spatial_things'],
      content: 'all',
      existing: 'replace',
    });
    expect(report.tables[0]).toMatchObject({ outcome: 'copied', rows: 4 });
    expect(await projection(other)).toEqual(before);
  });
});
