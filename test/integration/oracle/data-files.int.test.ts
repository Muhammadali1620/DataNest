// Files and copies for Oracle (V5 on V6.4), through the production services: a dump that
// loads into another schema twice over, a SQL*Plus script with PL/SQL and `/` lines, CSV
// and JSON imports, whole-table exports, generated test data, and copies of the shop to a
// SQLite file and back, and from schema to schema.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ObjectScope } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/oracle';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { SessionTarget } from '../../../src/services/connection-manager';
import { FileSink } from '../../../src/services/file-sink';
import { TableImporter } from '../../../src/services/import/table-import';
import type { ExportFormat } from '../../../src/services/result-export';
import { type ScriptChunk, ScriptRunner } from '../../../src/services/script-runner';
import { SqlDumper } from '../../../src/services/sql-dump';
import { StreamExporter } from '../../../src/services/stream-export';
import { readTextChunks } from '../../../src/services/text-file';
import {
  type TransferReport,
  TableTransferService,
} from '../../../src/services/transfer/table-transfer';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import type { ImportOptions } from '../../../src/shared/protocols/data-import';
import { DataImportModel } from '../../../src/vscode/panels/data-import-model';
import { TestDataModel } from '../../../src/vscode/panels/test-data-model';
import { ORACLE_SERVICE, testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';
import { entryText, unzip } from '../../helpers/unzip';

const SHOP = 'DATANEST';
const SCRATCH = 'DATANEST_EMPTY';
/** The seed's tables, the ones a dump of the shop is compared on. */
const SEED_TABLES = ['CUSTOMERS', 'PRODUCTS', 'ORDERS', 'ORDER_ITEMS', 'ALL_TYPES', 'BIG_TABLE'];

function config(): ResolvedConnectionConfig {
  const db = testDatabase('oracle');
  return {
    id: 'files-oracle',
    name: 'oracle',
    driver: 'oracle',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: ORACLE_SERVICE,
  };
}

/** A manager for task services: every owner gets a session of its own. */
function manager() {
  const sessions = new Map<string, Session>();
  return {
    driverOf: () => Promise.resolve(driver),
    acquire: async (owner: string) => {
      const opened = await driver.openSession(config());
      sessions.set(owner, opened);
      return opened;
    },
    release: async (owner: string) => {
      await sessions.get(owner)?.close();
      sessions.delete(owner);
    },
  };
}

let dir: string;
let worker: BuiltWorker;
let session: Session;

/** Drops everything a test may have left in the scratch schema. */
async function emptyScratch(): Promise<void> {
  const scope = { schema: SCRATCH };
  for (const kind of ['trigger', 'procedure', 'function', 'sequence'] as const) {
    for (const object of await session.metadata.listObjects(scope, kind)) {
      await runAll(session, driver.dialect.ddl.dropObject({ ...scope, ...object }));
    }
  }
  for (const table of await session.metadata.listTables(scope)) {
    await runAll(
      session,
      driver.dialect.ddl.dropRelation(
        { ...scope, name: table.name },
        table.kind === 'view' ? 'view' : 'table',
      ),
    );
  }
}

async function* parts(text: string, size = 4096): AsyncGenerator<ScriptChunk> {
  for (let offset = 0; offset < text.length; offset += size) {
    await Promise.resolve();
    const piece = text.slice(offset, offset + size);
    yield { text: piece, bytes: piece.length };
  }
}

async function runScript(script: string, size?: number) {
  return await new ScriptRunner({ manager: manager(), logger: new RecordingLogger() }).run({
    target: { connectionId: 'c' },
    chunks: parts(script, size),
    continueOnError: false,
  });
}

async function rowsOf(sql: string): Promise<string[]> {
  return (await runAll(session, sql)).rows.map((row) => JSON.stringify(row)).sort();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'datanest-oracle-files-'));
  worker = await buildSqliteWorker();
  session = await driver.openSession(config());
  await emptyScratch();
});

afterAll(async () => {
  await emptyScratch();
  await session.close();
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('dumps of Oracle', () => {
  let script = '';

  beforeAll(async () => {
    await emptyScratch();
    const scope = { schema: SHOP };
    const relations = (await session.metadata.listTables(scope)).filter(
      (table) => SEED_TABLES.includes(table.name) || table.name === 'ORDER_TOTALS',
    );
    await new SqlDumper({ manager: manager(), logger: new RecordingLogger() }).dump({
      target: { connectionId: 'c' },
      scope,
      relations,
      wholeScope: true,
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
  }, 120_000);

  it('ends every statement with a / line, as SQL*Plus reads it, and holds no storage clauses', () => {
    expect(script).toMatch(/END;\n\/\n/u);
    expect(script).toContain('EXECUTE IMMEDIATE');
    expect(script).toMatch(/BEGIN\n {2}INSERT INTO "DATANEST"\."BIG_TABLE"/u);
    expect(script).not.toMatch(/TABLESPACE|PCTFREE|INSERT ALL/u);
  });

  it('loads into another schema with the same rows and working routines, twice over', async () => {
    // A user restores another's dump by naming their own schema, as with REMAP_SCHEMA.
    expect(script).toContain('ALTER SESSION SET CURRENT_SCHEMA = "DATANEST"\n/\n');
    const remapped = script
      .replaceAll('"DATANEST".', '"DATANEST_EMPTY".')
      .replace('CURRENT_SCHEMA = "DATANEST"', 'CURRENT_SCHEMA = "DATANEST_EMPTY"');
    for (const pass of [1, 2]) {
      const report = await runScript(remapped);
      expect(report.stoppedAt, `pass ${pass}: ${JSON.stringify(report.stoppedAt)}`).toBeUndefined();
      expect(report.failedCount).toBe(0);
    }
    for (const table of SEED_TABLES) {
      expect(await rowsOf(`SELECT * FROM ${SCRATCH}.${table}`), table).toEqual(
        await rowsOf(`SELECT * FROM ${SHOP}.${table}`),
      );
    }
    expect(
      firstColumn(await runAll(session, `SELECT ${SCRATCH}.order_total(1) FROM dual`)),
    ).toEqual([{ kind: 'decimal', text: '88.99' }]);
    expect(
      firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${SCRATCH}.order_totals`)),
    ).toEqual([8]);
    // The trigger came after the rows, on the restored table, and works.
    expect(
      (
        await runAll(
          session,
          `SELECT table_owner FROM all_triggers WHERE owner = '${SCRATCH}' AND trigger_name = 'ORDER_ITEMS_QUANTITY_CHECK'`,
        )
      ).rows,
    ).toEqual([[SCRATCH]]);
    await expect(
      runAll(session, `INSERT INTO ${SCRATCH}.order_items VALUES (3, 1, 0, 1)`),
    ).rejects.toMatchObject({ code: 'constraint', driverCode: 'ORA-20001' });
    // Identity numbering goes on after the restored ids.
    await runAll(session, `INSERT INTO ${SCRATCH}.customers (email) VALUES ('new@example.com')`);
    expect(
      firstColumn(
        await runAll(
          session,
          `SELECT id FROM ${SCRATCH}.customers WHERE email = 'new@example.com'`,
        ),
      ),
    ).toEqual([6]);
    const sequences = await session.metadata.listObjects({ schema: SCRATCH }, 'sequence');
    expect(sequences.map((sequence) => sequence.name)).toEqual(['INVOICE_NUMBER_SEQ']);
  }, 180_000);
});

describe('running a SQL*Plus script file', () => {
  beforeEach(async () => {
    await emptyScratch();
  });

  it('runs SQL, PL/SQL blocks and routines split by ; and /, skipping SQL*Plus commands', async () => {
    const script = [
      'SET DEFINE OFF',
      'PROMPT Creating the table',
      'WHENEVER SQLERROR EXIT SQL.SQLCODE',
      `CREATE TABLE ${SCRATCH}.f_script (n NUMBER, note VARCHAR2(40));`,
      'BEGIN',
      '  FOR i IN 0..2 LOOP',
      `    INSERT INTO ${SCRATCH}.f_script (n) VALUES (i);`,
      '  END LOOP;',
      'END;',
      '/',
      `CREATE OR REPLACE PROCEDURE ${SCRATCH}.f_add(p IN NUMBER) AS`,
      'BEGIN',
      `  INSERT INTO ${SCRATCH}.f_script (n, note) VALUES (p, q'[it's; a / note]');`,
      'END;',
      '/',
      `BEGIN ${SCRATCH}.f_add(100); END;`,
      '/',
      `-- A comment; and a q-string with a semicolon`,
      `UPDATE ${SCRATCH}.f_script SET note = 'x;y' WHERE n = 0;`,
      '',
    ].join('\n');
    // Small pieces, so blocks and strings go on across them.
    const report = await runScript(script, 64);
    expect(report.stoppedAt, JSON.stringify(report.stoppedAt)).toBeUndefined();
    expect(report).toMatchObject({ outcome: 'done', failedCount: 0, statements: 5 });
    expect(
      (await runAll(session, `SELECT n, note FROM ${SCRATCH}.f_script ORDER BY n`)).rows,
    ).toEqual([
      [0, 'x;y'],
      [1, null],
      [2, null],
      [100, "it's; a / note"],
    ]);
  });

  it('names the line a failed statement starts on', async () => {
    const report = await runScript('SELECT 1 FROM dual;\n\nSELECT * FROM no_such_table;\n');
    expect(report.outcome).toBe('stopped');
    expect(report.stoppedAt).toMatchObject({ line: 3 });
  });
});

describe('importing files', () => {
  const table = { schema: SCRATCH, name: 'F_PEOPLE' };
  const CSV: ImportOptions = {
    format: 'csv',
    delimiter: ',',
    header: true,
    emptyIsNull: true,
    nullText: '\\N',
  };

  beforeEach(async () => {
    await emptyScratch();
    await runAll(
      session,
      `CREATE TABLE ${SCRATCH}.f_people (id NUMBER(10) GENERATED BY DEFAULT ON NULL AS IDENTITY
         PRIMARY KEY, name NVARCHAR2(50) NOT NULL, born DATE, score NUMBER(6,2), active BOOLEAN,
         note CLOB)`,
    );
  });

  async function importFile(
    name: string,
    text: string,
    options: ImportOptions,
    mode: 'all' | 'skip',
  ) {
    const file = join(dir, name);
    writeFileSync(file, text);
    const model = new DataImportModel({
      target: { connectionId: 'c' },
      table,
      driver: 'oracle',
      file,
      columns: (await session.metadata.describeTable(table)).columns,
      readChunks: (path) => readTextChunks(path, 16),
      importer: new TableImporter({ manager: manager(), logger: new RecordingLogger() }),
    });
    const { mapping } = await model.load(options);
    return await model.run(options, mapping, mode);
  }

  it('imports CSV with identity values and DATEs with their time, leaving out a row that does not fit', async () => {
    const long = 'é'.repeat(5000);
    const csv = [
      'ID,NAME,BORN,SCORE,ACTIVE,NOTE',
      '1,Anna,2000-01-31 08:30:00,12.50,true,"Line one\nline two"',
      '2,"O\'Brien, Bob",\\N,,false,"say ""hi"""',
      `3,Ольга,1999-12-31 00:00:00,0.10,1,${long}`,
      '4,Bad Date,1999-02-30 00:00:00,1,true,x',
      '',
    ].join('\n');
    const report = await importFile('people.csv', csv, CSV, 'skip');
    expect(report).toMatchObject({ outcome: 'done', read: 4, inserted: 3, failedCount: 1 });
    const rows = (
      await runAll(
        session,
        `SELECT id, name, born, score, active, note FROM ${SCRATCH}.f_people ORDER BY id`,
      )
    ).rows;
    expect(rows.map((row) => row[1])).toEqual(['Anna', "O'Brien, Bob", 'Ольга']);
    expect(rows[0]).toEqual([
      1,
      'Anna',
      { kind: 'datetime', text: '2000-01-31 08:30:00' },
      { kind: 'decimal', text: '12.5' },
      true,
      'Line one\nline two',
    ]);
    // Text longer than one literal holds arrives whole.
    expect(rows[2]?.[5]).toBe(long);
    await runAll(session, `INSERT INTO ${SCRATCH}.f_people (name) VALUES ('next')`);
    expect(
      firstColumn(await runAll(session, `SELECT id FROM ${SCRATCH}.f_people WHERE name = 'next'`)),
    ).toEqual([4]);
  });

  it('keeps nothing when the server refuses a row in all-or-nothing mode', async () => {
    const report = await importFile('dup.csv', 'ID,NAME\n1,a\n1,b\n', CSV, 'all');
    expect(report.outcome).toBe('stopped');
    expect(firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${SCRATCH}.f_people`))).toEqual([
      0,
    ]);
  });

  it('imports JSON records without ids: the identity numbers each row', async () => {
    const json = JSON.stringify([
      {
        NAME: 'Json',
        BORN: '2001-02-03 04:05:06',
        SCORE: 99.99,
        ACTIVE: true,
        NOTE: { tags: [1] },
      },
      { NAME: 'Nulls', BORN: null, SCORE: null, ACTIVE: false },
      { NAME: 'Third' },
    ]);
    const report = await importFile('people.json', json, { ...CSV, format: 'json' }, 'all');
    expect(report).toMatchObject({ outcome: 'done', inserted: 3, failedCount: 0 });
    expect(
      (await runAll(session, `SELECT id, note FROM ${SCRATCH}.f_people ORDER BY id`)).rows,
    ).toEqual([
      [1, '{"tags":[1]}'],
      [2, null],
      [3, null],
    ]);
  });
});

describe('exporting a whole table', () => {
  async function exportTo(format: ExportFormat): Promise<Buffer> {
    const path = join(dir, `big.${format}`);
    const sink = await FileSink.create(path);
    const report = await new StreamExporter({
      manager: manager(),
      logger: new RecordingLogger(),
    }).export({
      target: { connectionId: 'c' },
      sql: `SELECT id, label, value_mod FROM ${SHOP}.big_table ORDER BY id`,
      format,
      sink,
      table: { schema: SHOP, name: 'BIG_TABLE' },
    });
    await sink.close();
    expect(report.rows).toBe(10_000);
    return readFileSync(path);
  }

  it('writes every row as CSV, JSON, XLSX and SQL that loads back', async () => {
    const csv = (await exportTo('csv')).toString('utf8').trim().split(/\r?\n/u);
    expect(csv).toHaveLength(10_001);
    expect(csv[1]).toBe('1,row-00001,1');
    const json = JSON.parse((await exportTo('json')).toString('utf8')) as unknown[];
    expect(json).toHaveLength(10_000);
    const sheet = entryText(unzip(await exportTo('xlsx')), 'xl/worksheets/sheet1.xml');
    expect(sheet.match(/<row /gu)).toHaveLength(10_001);

    const sql = (await exportTo('sql')).toString('utf8');
    expect(sql).toMatch(
      /^BEGIN\n {2}INSERT INTO "DATANEST"\."BIG_TABLE" \("ID", "LABEL", "VALUE_MOD"\)/u,
    );
    await emptyScratch();
    await runAll(
      session,
      `CREATE TABLE ${SCRATCH}.big_table (id NUMBER(10) PRIMARY KEY, label VARCHAR2(32), value_mod NUMBER(10))`,
    );
    const report = await runScript(sql.replaceAll('"DATANEST".', '"DATANEST_EMPTY".'));
    expect(report.stoppedAt, JSON.stringify(report.stoppedAt)).toBeUndefined();
    expect(firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${SCRATCH}.big_table`))).toEqual(
      [10_000],
    );
  });
});

describe('generated test data', () => {
  beforeAll(async () => {
    await emptyScratch();
    await runAll(
      session,
      `CREATE TABLE ${SCRATCH}.td_teams (id NUMBER(10) GENERATED BY DEFAULT ON NULL AS IDENTITY PRIMARY KEY, name NVARCHAR2(20))`,
    );
    await runAll(
      session,
      `BEGIN FOR i IN 1..3 LOOP INSERT INTO ${SCRATCH}.td_teams (name) VALUES ('team ' || i); END LOOP; END;`,
    );
    await runAll(
      session,
      `CREATE TABLE ${SCRATCH}.td_people (id NUMBER(10) GENERATED BY DEFAULT ON NULL AS IDENTITY PRIMARY KEY,
         email VARCHAR2(60 CHAR) NOT NULL UNIQUE,
         team_id NUMBER(10) NOT NULL REFERENCES ${SCRATCH}.td_teams (id), born DATE,
         score NUMBER(5,2), active BOOLEAN, code CHAR(4), seen TIMESTAMP(3) WITH TIME ZONE,
         notes CLOB, doubled NUMBER GENERATED ALWAYS AS (team_id * 2) VIRTUAL)`,
    );
  });

  async function model(): Promise<TestDataModel> {
    const table = { schema: SCRATCH, name: 'TD_PEOPLE' };
    return new TestDataModel({
      target: { connectionId: 'c' },
      table,
      driver: 'oracle',
      dialect: driver.dialect,
      structure: await session.metadata.describeTable(table),
      session: () => Promise.resolve(session),
      importer: new TableImporter({ manager: manager(), logger: new RecordingLogger() }),
    });
  }

  it('inserts rows that fit every column and key', async () => {
    const generator = await model();
    const report = await generator.run(generator.initialState('t').choices, 500, 12345);
    expect(report.failures, JSON.stringify(report.failures)).toEqual([]);
    expect(report).toMatchObject({ outcome: 'done', inserted: 500, failedCount: 0 });
    expect(
      firstColumn(await runAll(session, `SELECT COUNT(DISTINCT email) FROM ${SCRATCH}.td_people`)),
    ).toEqual([500]);
    const teams = firstColumn(
      await runAll(session, `SELECT DISTINCT team_id FROM ${SCRATCH}.td_people`),
    );
    expect(teams.every((id) => [1, 2, 3].includes(Number(id)))).toBe(true);
  });

  it('keeps nothing when the same seed breaks the unique key', async () => {
    const generator = await model();
    const report = await generator.run(generator.initialState('t').choices, 500, 12345);
    expect(report).toMatchObject({ outcome: 'stopped', rolledBack: true });
    expect(firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${SCRATCH}.td_people`))).toEqual(
      [500],
    );
  });

  it('writes a script that runs as it is', async () => {
    const generator = await model();
    const script = await generator.script(generator.initialState('t').choices, 50, 777);
    const report = await runScript(script);
    expect(report.stoppedAt, JSON.stringify(report.stoppedAt)).toBeUndefined();
    expect(firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${SCRATCH}.td_people`))).toEqual(
      [550],
    );
  });
});

describe('copies to and from Oracle', () => {
  const sqlite = () => createSqliteDriver({ workerPath: worker.workerPath });
  const file = () => join(dir, 'shop.db');

  interface End {
    readonly driver: () => Driver;
    readonly config: () => ResolvedConnectionConfig;
    readonly scope: ObjectScope;
  }

  const oracleEnd = (schema: string): End => ({
    driver: () => driver,
    config,
    scope: { schema },
  });
  const sqliteEnd: End = {
    driver: sqlite,
    config: () => ({ id: 's', name: 's', driver: 'sqlite', file: file() }),
    scope: {},
  };

  async function transfer(
    from: End,
    to: End,
    tables: string[],
    existing: 'replace' | 'append' = 'replace',
  ): Promise<TransferReport> {
    const ends = new Map([
      ['from', from],
      ['to', to],
    ]);
    const sessions = new Map<string, Session>();
    return await new TableTransferService({
      manager: {
        driverOf: (connectionId) => Promise.resolve((ends.get(connectionId) ?? from).driver()),
        acquire: async (owner: string, target: SessionTarget) => {
          const end = ends.get(target.connectionId) ?? from;
          const opened = await end.driver().openSession(end.config());
          sessions.set(owner, opened);
          return opened;
        },
        release: async (owner) => {
          await sessions.get(owner)?.close();
        },
      },
      logger: new RecordingLogger(),
    }).transfer({
      source: { target: { connectionId: 'from' }, scope: from.scope },
      destination: { target: { connectionId: 'to' }, scope: to.scope },
      tables,
      content: 'all',
      existing,
    });
  }

  function expectCopied(report: TransferReport): void {
    for (const table of report.tables) {
      expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
    }
  }

  const SHOP_TABLES = ['CUSTOMERS', 'PRODUCTS', 'ORDERS', 'ORDER_ITEMS'];

  it('copies the shop and the type-rich table into SQLite, and back into another schema', async () => {
    await emptyScratch();
    const out = await transfer(oracleEnd(SHOP), sqliteEnd, [
      ...SHOP_TABLES,
      'ALL_TYPES',
      'BIG_TABLE',
    ]);
    expectCopied(out);
    const back = await transfer(sqliteEnd, oracleEnd(SCRATCH), [...SHOP_TABLES, 'BIG_TABLE']);
    expectCopied(back);
    // SQLite keeps no precision, so TIMESTAMP(0) comes back as TIMESTAMP(6): zeros added.
    const plain = async (sql: string) =>
      (await rowsOf(sql)).map((row) => row.replaceAll(/\.0+"/gu, '"'));
    // SQLite has no BOOLEAN or JSON either: those come back as a number and as text.
    const kept = (name: string) => !['IS_ACTIVE', 'ATTRIBUTES'].includes(name);
    for (const table of SHOP_TABLES) {
      const columns = (await session.metadata.listColumns({ schema: SHOP, name: table }))
        .map((column) => column.name)
        .filter(kept)
        .join(', ');
      expect(await plain(`SELECT ${columns} FROM ${SCRATCH}.${table}`), table).toEqual(
        await plain(`SELECT ${columns} FROM ${SHOP}.${table}`),
      );
    }
    expect(firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${SCRATCH}.big_table`))).toEqual(
      [10_000],
    );
    await expect(
      runAll(
        session,
        `INSERT INTO ${SCRATCH}.orders (customer_id, status, ordered_at) VALUES (999, 'new', SYSDATE)`,
      ),
    ).rejects.toMatchObject({ code: 'constraint' });
  }, 180_000);

  it('copies between schemas keeping the types as they are', async () => {
    await emptyScratch();
    const report = await transfer(oracleEnd(SHOP), oracleEnd(SCRATCH), [
      ...SHOP_TABLES,
      'ALL_TYPES',
    ]);
    expectCopied(report);
    expect(await rowsOf(`SELECT * FROM ${SCRATCH}.all_types`)).toEqual(
      await rowsOf(`SELECT * FROM ${SHOP}.all_types`),
    );
    const columns = await session.metadata.listColumns({ schema: SCRATCH, name: 'ALL_TYPES' });
    expect(columns.find((column) => column.name === 'C_TIMESTAMP_TZ')?.dataType).toBe(
      'TIMESTAMP(6) WITH TIME ZONE',
    );
    await runAll(session, `DELETE FROM ${SCRATCH}.order_items`);
    const append = await transfer(oracleEnd(SHOP), oracleEnd(SCRATCH), ['ORDER_ITEMS'], 'append');
    expect(append.tables[0]).toMatchObject({ outcome: 'copied', created: false, rows: 12 });
  }, 180_000);
});
