// Test data on real servers (V5.5): generated rows go in with their types, unique
// columns do not repeat, foreign keys point at rows that exist, and a run that
// breaks a key keeps nothing.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableRef } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { TableImporter } from '../../../src/services/import/table-import';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import { TestDataModel } from '../../../src/vscode/panels/test-data-model';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-testdata-'));
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
  readonly schema?: string;
  readonly setup: readonly string[];
  readonly teardown: readonly string[];
}

function server(id: TestDatabaseId, driver: Driver, setup: string[], teardown: string[]): Target {
  const driverId = id === 'postgres' ? 'postgres' : 'mysql';
  return {
    label: id,
    driverId,
    driver: () => driver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `td-${id}`,
        name: id,
        driver: driverId,
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
      };
    },
    ...(driverId === 'postgres' ? { schema: 'public' } : {}),
    setup,
    teardown,
  };
}

const MYSQL_SETUP = [
  'DROP TABLE IF EXISTS td_people, td_teams',
  'CREATE TABLE td_teams (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(20))',
  "INSERT INTO td_teams (name) VALUES ('a'), ('b'), ('c')",
  `CREATE TABLE td_people (id INT AUTO_INCREMENT PRIMARY KEY, email VARCHAR(60) NOT NULL UNIQUE,
     team_id INT NOT NULL, born DATE, score DECIMAL(5,2), active BOOLEAN, code CHAR(4),
     size ENUM('s','m','l') NOT NULL, note TEXT,
     CONSTRAINT fk_td FOREIGN KEY (team_id) REFERENCES td_teams (id))`,
];

const TARGETS: readonly Target[] = [
  server('mysql', mysqlDriver, MYSQL_SETUP, ['DROP TABLE IF EXISTS td_people, td_teams']),
  server('mariadb', mysqlDriver, MYSQL_SETUP, ['DROP TABLE IF EXISTS td_people, td_teams']),
  server(
    'postgres',
    postgresDriver,
    [
      'DROP TABLE IF EXISTS public.td_people, public.td_teams',
      'CREATE TABLE public.td_teams (id serial PRIMARY KEY, name varchar(20))',
      "INSERT INTO public.td_teams (name) VALUES ('a'), ('b'), ('c')",
      `CREATE TABLE public.td_people (id int GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
         email varchar(60) NOT NULL UNIQUE, team_id int NOT NULL REFERENCES public.td_teams (id),
         born date, score numeric(5,2), active boolean, code char(4), token uuid, note text,
         doubled int GENERATED ALWAYS AS (team_id * 2) STORED)`,
    ],
    ['DROP TABLE IF EXISTS public.td_people, public.td_teams'],
  ),
  {
    label: 'sqlite',
    driverId: 'sqlite',
    driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
    config: () => ({ id: 'td-sqlite', name: 'sqlite', driver: 'sqlite', file: join(dir, 't.db') }),
    setup: [
      'DROP TABLE IF EXISTS td_people',
      'DROP TABLE IF EXISTS td_teams',
      'CREATE TABLE td_teams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)',
      "INSERT INTO td_teams (name) VALUES ('a'), ('b'), ('c')",
      `CREATE TABLE td_people (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL UNIQUE,
         team_id INTEGER NOT NULL REFERENCES td_teams (id), born DATE, score NUMERIC(5,2),
         active BOOLEAN, code CHAR(4), note TEXT)`,
    ],
    teardown: ['DROP TABLE IF EXISTS td_people', 'DROP TABLE IF EXISTS td_teams'],
  },
];

describe.each(TARGETS)('$label', (target) => {
  let session: Session;
  const table: TableRef = {
    ...(target.schema === undefined ? {} : { schema: target.schema }),
    name: 'td_people',
  };
  const name = target.schema === undefined ? 'td_people' : `${target.schema}.td_people`;

  beforeAll(async () => {
    session = await target.driver().openSession(target.config());
    for (const sql of target.setup) {
      await runAll(session, sql);
    }
  });

  afterAll(async () => {
    for (const sql of target.teardown) {
      await runAll(session, sql);
    }
    await session.close();
  });

  async function model(): Promise<TestDataModel> {
    const driver = target.driver();
    const sessions = new Map<string, Session>();
    return new TestDataModel({
      target: { connectionId: 'c' },
      table,
      driver: target.driverId,
      dialect: driver.dialect,
      structure: await session.metadata.describeTable(table),
      session: () => Promise.resolve(session),
      importer: new TableImporter({
        manager: {
          driverOf: () => Promise.resolve(driver),
          acquire: async (owner) => {
            const opened = await driver.openSession(target.config());
            sessions.set(owner, opened);
            return opened;
          },
          release: async (owner) => {
            await sessions.get(owner)?.close();
          },
        },
        logger: new RecordingLogger(),
      }),
    });
  }

  it('inserts generated rows that fit every column and key', async () => {
    const generator = await model();
    const choices = generator.initialState('t').choices;
    const report = await generator.run(choices, 500, 12345);
    expect(report).toMatchObject({ outcome: 'done', inserted: 500, failedCount: 0 });
    const count = firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${name}`));
    expect(Number(count[0])).toBe(500);
    const emails = firstColumn(await runAll(session, `SELECT COUNT(DISTINCT email) FROM ${name}`));
    expect(Number(emails[0])).toBe(500);
    const teams = firstColumn(
      await runAll(session, `SELECT DISTINCT team_id FROM ${name} ORDER BY 1`),
    );
    expect(teams.every((id) => [1, 2, 3].includes(Number(id)))).toBe(true);
    const codes = firstColumn(await runAll(session, `SELECT code FROM ${name}`));
    expect(codes.every((code) => typeof code === 'string' && code.trimEnd().length <= 4)).toBe(
      true,
    );
  });

  it('keeps nothing when the rows break a unique key', async () => {
    const generator = await model();
    // The same seed makes the same emails again.
    const report = await generator.run(generator.initialState('t').choices, 500, 12345);
    expect(report.outcome).toBe('stopped');
    expect(report.rolledBack).toBe(true);
    const count = firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${name}`));
    expect(Number(count[0])).toBe(500);
  });

  it('writes a script that runs as it is', async () => {
    const generator = await model();
    const script = await generator.script(generator.initialState('t').choices, 50, 777);
    for (const statement of script.split(';\n').filter((text) => text.trim() !== '')) {
      await runAll(session, statement);
    }
    const count = firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${name}`));
    expect(Number(count[0])).toBe(550);
  });
});
