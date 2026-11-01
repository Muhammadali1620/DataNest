// PostGIS on a real server (V13.13): geometry and geography arrive as extended WKT, which
// the server reads back as the same value, and a dump of them restores to the same rows.

import { afterAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import type { SessionTarget } from '../../../src/services/connection-manager';
import { type ScriptChunk, ScriptRunner } from '../../../src/services/script-runner';
import { SqlDumper } from '../../../src/services/sql-dump';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';

const db = testDatabase('postgis');

function config(): ResolvedConnectionConfig {
  return {
    id: 'postgis',
    name: 'postgis',
    driver: 'postgres',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

async function use<T>(run: (session: Session) => Promise<T>): Promise<T> {
  const session = await postgresDriver.openSession(config());
  try {
    return await run(session);
  } finally {
    await session.close();
  }
}

/** The seed rows, in order: id, then the four spatial and text columns. */
async function seedRows(session: Session) {
  return await runAll(
    session,
    'SELECT id, location, area, trail, note FROM spatial_places WHERE id < 100 ORDER BY id',
  );
}

afterAll(async () => {
  await use((session) => runAll(session, 'DELETE FROM spatial_places WHERE id >= 100'));
});

describe('PostGIS values', () => {
  it('shows geometry and geography as extended WKT', async () => {
    const result = await use(seedRows);
    expect(result.rows).toEqual([
      [
        1,
        'SRID=4326;POINT(13.4 52.5)',
        'POLYGON((0 0, 4 0, 4 4, 0 4, 0 0))',
        'SRID=4326;LINESTRING(13.4 52.5, 13.5 52.6)',
        'SRID=4326;POINT(1 2)',
      ],
      [2, 'SRID=4326;POINT(-0.1278 51.5074)', 'SRID=3857;MULTIPOINT((1 2), (3 4))', null, null],
      [3, 'SRID=4326;POINT(13.41 52.51)', 'SRID=4979;POINT Z (1 2 3)', null, 'POINT(1 2)'],
      [4, null, 'POINT EMPTY', null, null],
      [5, null, 'GEOMETRYCOLLECTION(POINT(1 2), LINESTRING(0 0, 1 1))', null, null],
    ]);
  });

  it('names the spatial types of the columns, and leaves a text column text', async () => {
    const result = await use(seedRows);
    expect(result.columnSets[0]?.map((column) => column.dataType)).toEqual([
      'int4',
      'geometry',
      'geometry',
      'geography',
      'text',
    ]);
  });

  it('shows the same shape whichever way the query builds the value', async () => {
    const result = await use((session) =>
      runAll(
        session,
        `SELECT ST_MakePoint(1.5, -2.25), ST_SetSRID(ST_MakePoint(1, 2), 4326)::geography,
                ST_Collect(ST_MakePoint(1, 2), ST_MakePoint(3, 4)),
                ST_GeomFromText('LINESTRING EMPTY')`,
      ),
    );
    expect(result.rows[0]).toEqual([
      'POINT(1.5 -2.25)',
      'SRID=4326;POINT(1 2)',
      'MULTIPOINT((1 2), (3 4))',
      'LINESTRING EMPTY',
    ]);
  });

  it('reads the text back as the very value it came from', async () => {
    await use(async (session) => {
      const result = await seedRows(session);
      for (const row of result.rows) {
        for (const [index, column] of [
          [1, 'location'],
          [2, 'area'],
          [3, 'trail'],
        ] as const) {
          const text = row[index];
          if (typeof text !== 'string') {
            continue;
          }
          const type = column === 'trail' ? 'geography' : 'geometry';
          const same = await runAll(
            session,
            `SELECT ${column}::text = '${text}'::${type}::text FROM spatial_places WHERE id = ${row[0] as number}`,
          );
          expect(same.rows[0]?.[0], `${column} of row ${row[0] as number}`).toBe(true);
        }
      }
    });
  });

  it('accepts a cell written as shown, and shows it as it was written', async () => {
    await use(async (session) => {
      await runAll(
        session,
        `INSERT INTO spatial_places (id, name, location, area, trail) VALUES
          (100, 'Written', 'SRID=4326;POINT(5 6)', 'SRID=3857;POLYGON((0 0, 1 0, 0 1, 0 0))',
           'SRID=4326;LINESTRING(0 0, 1 1)')`,
      );
      const written = await runAll(
        session,
        'SELECT location, area, trail FROM spatial_places WHERE id = 100',
      );
      expect(written.rows[0]).toEqual([
        'SRID=4326;POINT(5 6)',
        'SRID=3857;POLYGON((0 0, 1 0, 0 1, 0 0))',
        'SRID=4326;LINESTRING(0 0, 1 1)',
      ]);
      await runAll(
        session,
        "UPDATE spatial_places SET location = 'SRID=4326;POINT(7 8)' WHERE id = 100",
      );
      const changed = await runAll(session, 'SELECT location FROM spatial_places WHERE id = 100');
      expect(changed.rows[0]?.[0]).toBe('SRID=4326;POINT(7 8)');
      await runAll(session, 'DELETE FROM spatial_places WHERE id = 100');
    });
  });

  it('keeps every digit of a coordinate', async () => {
    const result = await use((session) =>
      runAll(session, 'SELECT ST_SetSRID(ST_MakePoint(0.1, 1e-7), 4326), ST_MakePoint(1e21, -0.5)'),
    );
    expect(result.rows[0]).toEqual(['SRID=4326;POINT(0.1 1e-7)', 'POINT(1e+21 -0.5)']);
  });

  it('keeps a value it cannot read as the hex the server sent', async () => {
    const result = await use((session) =>
      runAll(session, "SELECT ST_GeomFromText('CIRCULARSTRING(0 0, 1 1, 2 0)')"),
    );
    expect(result.rows[0]?.[0]).toMatch(/^[0-9A-F]+$/u);
  });
});

async function* parts(text: string): AsyncGenerator<ScriptChunk> {
  await Promise.resolve();
  yield { text, bytes: text.length };
}

describe('a dump of PostGIS tables', () => {
  it('restores every geometry, with its SRID, dimensions and holes', async () => {
    const sessions = new Map<string, Session>();
    const manager = {
      driverOf: () => Promise.resolve(postgresDriver),
      acquire: async (owner: string, _target: SessionTarget) => {
        const session = await postgresDriver.openSession(config());
        sessions.set(owner, session);
        return session;
      },
      release: async (owner: string) => {
        await sessions.get(owner)?.close();
        sessions.delete(owner);
      },
    };
    const before = await use(async (session) => (await seedRows(session)).rows);
    let script = '';
    const report = await new SqlDumper({ manager, logger: new RecordingLogger() }).dump({
      target: { connectionId: 'c', database: db.database },
      scope: { database: db.database, schema: 'public' },
      relations: [{ name: 'spatial_places', kind: 'table' }],
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
    expect(report.tables).toBe(1);
    // The geometries are written as text, not as the hex of their bytes.
    expect(script).toContain('SRID=4326;POINT(13.4 52.5)');
    expect(script).toContain('SRID=4979;POINT Z (1 2 3)');

    await use((session) => runAll(session, 'DELETE FROM spatial_places'));
    const run = await new ScriptRunner({ manager, logger: new RecordingLogger() }).run({
      target: { connectionId: 'c', database: db.database },
      chunks: parts(script),
      continueOnError: false,
    });
    expect(run.stoppedAt, JSON.stringify(run.stoppedAt)).toBeUndefined();
    expect(run.failedCount).toBe(0);
    const after = await use(async (session) => (await seedRows(session)).rows);
    expect(after).toEqual(before);
  });
});
