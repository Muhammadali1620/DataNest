// Importing CSV and JSON files into real tables (V5.3): values arrive with their
// types, bad rows are left out or undo everything, and sequences go on after
// imported ids.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { TableRef } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { TableImporter } from '../../../src/services/import/table-import';
import { readTextChunks } from '../../../src/services/text-file';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import type { ImportOptions } from '../../../src/shared/protocols/data-import';
import { DataImportModel } from '../../../src/vscode/panels/data-import-model';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-import-'));
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
  readonly table: TableRef;
  readonly create: string;
}

function server(id: TestDatabaseId, driver: Driver, create: string): Target {
  const driverId = id === 'postgres' ? 'postgres' : 'mysql';
  return {
    label: id,
    driverId,
    driver: () => driver,
    config: () => {
      const db = testDatabase(id);
      return {
        id: `imp-${id}`,
        name: id,
        driver: driverId,
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: db.database,
      };
    },
    table:
      driverId === 'postgres' ? { schema: 'public', name: 'imp_people' } : { name: 'imp_people' },
    create,
  };
}

const TARGETS: readonly Target[] = [
  server(
    'mysql',
    mysqlDriver,
    `CREATE TABLE imp_people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL,
       born DATE, score DECIMAL(6,2), active BOOLEAN, note TEXT)`,
  ),
  server(
    'mariadb',
    mysqlDriver,
    `CREATE TABLE imp_people (id INT AUTO_INCREMENT PRIMARY KEY, name VARCHAR(50) NOT NULL,
       born DATE, score DECIMAL(6,2), active BOOLEAN, note TEXT)`,
  ),
  server(
    'postgres',
    postgresDriver,
    `CREATE TABLE public.imp_people (id serial PRIMARY KEY, name varchar(50) NOT NULL,
       born date, score numeric(6,2), active boolean, note text)`,
  ),
  {
    label: 'sqlite',
    driverId: 'sqlite',
    driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
    config: () => ({ id: 'imp-sqlite', name: 'sqlite', driver: 'sqlite', file: join(dir, 'i.db') }),
    table: { name: 'imp_people' },
    create: `CREATE TABLE imp_people (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
       born DATE, score NUMERIC(6,2), active BOOLEAN, note TEXT)`,
  },
];

const CSV: ImportOptions = {
  format: 'csv',
  delimiter: ',',
  header: true,
  emptyIsNull: true,
  nullText: '\\N',
};

const PEOPLE_CSV = [
  'id,name,born,score,active,note',
  '1,Anna,2000-01-31,12.50,true,"Line one\nline two"',
  '2,"O\'Brien, Bob",\\N,,false,"say ""hi"""',
  '3,Ольга,1999-12-31,0.10,1,',
  '4,Bad Date,1999-02-30,1,true,x',
  '',
].join('\n');

describe.each(TARGETS)('$label', (target) => {
  let session: Session;

  async function importFile(
    name: string,
    text: string,
    options: ImportOptions,
    mode: 'all' | 'skip',
  ) {
    const file = join(dir, `${target.label}-${name}`);
    writeFileSync(file, text);
    const structure = await session.metadata.describeTable(target.table);
    const sessions = new Map<string, Session>();
    const driver = target.driver();
    const importer = new TableImporter({
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
    });
    const model = new DataImportModel({
      target: { connectionId: 'c' },
      table: target.table,
      driver: target.driverId,
      file,
      columns: structure.columns,
      readChunks: (path) => readTextChunks(path, 16),
      importer,
    });
    const { mapping } = await model.load(options);
    return await model.run(options, mapping, mode);
  }

  async function rows(): Promise<unknown[][]> {
    const name = target.driverId === 'postgres' ? 'public.imp_people' : 'imp_people';
    return (
      await runAll(session, `SELECT id, name, born, score, active, note FROM ${name} ORDER BY id`)
    ).rows.map((row) => [...row]);
  }

  beforeAll(async () => {
    session = await target.driver().openSession(target.config());
  });

  beforeEach(async () => {
    const name = target.driverId === 'postgres' ? 'public.imp_people' : 'imp_people';
    await runAll(session, `DROP TABLE IF EXISTS ${name}`);
    await runAll(session, target.create);
  });

  afterAll(async () => {
    const name = target.driverId === 'postgres' ? 'public.imp_people' : 'imp_people';
    await runAll(session, `DROP TABLE IF EXISTS ${name}`);
    await session.close();
  });

  it('imports a CSV file, leaving out the row that does not fit', async () => {
    const report = await importFile('people.csv', PEOPLE_CSV, CSV, 'skip');
    expect(report).toMatchObject({ outcome: 'done', read: 4, inserted: 3, failedCount: 1 });
    expect(report.failures[0]).toMatchObject({ line: 6, column: 'born', problem: 'invalid-date' });
    const stored = await rows();
    expect(stored.map((row) => row[1])).toEqual(['Anna', "O'Brien, Bob", 'Ольга']);
    expect(stored[0]?.[5]).toBe('Line one\nline two');
    expect(stored[1]?.[2]).toBeNull();
    expect(stored[1]?.[3]).toBeNull();
    expect(stored[1]?.[5]).toBe('say "hi"');
    expect(stored[2]?.[5]).toBeNull();
    expect(JSON.stringify(stored[2]?.[3])).toContain('0.1');
  });

  it('keeps nothing when one row does not fit in all-or-nothing mode', async () => {
    const report = await importFile('people-all.csv', PEOPLE_CSV, CSV, 'all');
    expect(report).toMatchObject({ outcome: 'stopped', inserted: 0, rolledBack: true });
    expect(await rows()).toEqual([]);
  });

  it('keeps nothing when the server refuses a row in all-or-nothing mode', async () => {
    const duplicate = 'id,name\n1,a\n1,b\n';
    const report = await importFile('dup.csv', duplicate, CSV, 'all');
    expect(report.outcome).toBe('stopped');
    expect(report.failures[0]?.message).toBeDefined();
    expect(await rows()).toEqual([]);
  });

  it('imports JSON records and goes on numbering after the imported ids', async () => {
    const json = JSON.stringify([
      { id: 7, name: 'Json', born: '2001-02-03', score: 99.99, active: true, note: { tags: [1] } },
      { id: 8, name: 'Nulls', born: null, score: null, active: false },
    ]);
    const report = await importFile('people.json', json, { ...CSV, format: 'json' }, 'all');
    expect(report).toMatchObject({ outcome: 'done', inserted: 2, failedCount: 0 });
    const name = target.driverId === 'postgres' ? 'public.imp_people' : 'imp_people';
    await runAll(session, `INSERT INTO ${name} (name) VALUES ('next')`);
    const stored = await rows();
    expect(stored.map((row) => row[0])).toEqual([7, 8, 9]);
    expect(stored[0]?.[5]).toBe('{"tags":[1]}');
  });
});
