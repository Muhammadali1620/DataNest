// Files in and out of SQL Server (V5 on V6.2): a T-SQL script with GO and variables,
// CSV and JSON imports with identity values, whole-table exports in every format, and
// generated test data, all through the production services.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/mssql';
import { FileSink } from '../../../src/services/file-sink';
import { TableImporter } from '../../../src/services/import/table-import';
import type { ExportFormat } from '../../../src/services/result-export';
import { type ScriptChunk, ScriptRunner } from '../../../src/services/script-runner';
import { StreamExporter } from '../../../src/services/stream-export';
import { readTextChunks } from '../../../src/services/text-file';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import type { ImportOptions } from '../../../src/shared/protocols/data-import';
import { DataImportModel } from '../../../src/vscode/panels/data-import-model';
import { TestDataModel } from '../../../src/vscode/panels/test-data-model';
import { testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { RecordingLogger } from '../../helpers/fakes';
import { entryText, unzip } from '../../helpers/unzip';

function config(): ResolvedConnectionConfig {
  const db = testDatabase('mssql');
  return {
    id: 'files-mssql',
    name: 'mssql',
    driver: 'mssql',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

function manager() {
  const sessions = new Map<string, Session>();
  return {
    driverOf: () => Promise.resolve(driver),
    acquire: async (owner: string) => {
      const session = await driver.openSession(config());
      sessions.set(owner, session);
      return session;
    },
    release: async (owner: string) => {
      await sessions.get(owner)?.close();
      sessions.delete(owner);
    },
  };
}

let dir: string;
let session: Session;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'datanest-mssql-files-'));
  session = await driver.openSession(config());
});

afterAll(async () => {
  await runAll(session, 'DROP TABLE IF EXISTS dbo.f_people, dbo.f_audit, dbo.f_script');
  await runAll(session, 'DROP TABLE IF EXISTS dbo.td_people, dbo.td_teams');
  await session.close();
  rmSync(dir, { recursive: true, force: true });
});

async function* parts(text: string): AsyncGenerator<ScriptChunk> {
  for (let offset = 0; offset < text.length; offset += 64) {
    await Promise.resolve();
    const piece = text.slice(offset, offset + 64);
    yield { text: piece, bytes: piece.length };
  }
}

describe('running a T-SQL script file', () => {
  it('runs batches split by GO, with variables, procedures and blocks', async () => {
    const script = [
      'DROP TABLE IF EXISTS dbo.f_script;',
      'CREATE TABLE dbo.f_script (n INT);',
      'GO',
      'DECLARE @i INT = 0;',
      'WHILE @i < 3',
      'BEGIN',
      '  INSERT INTO dbo.f_script VALUES (@i);',
      '  SET @i += 1;',
      'END;',
      'GO',
      'CREATE OR ALTER PROCEDURE dbo.f_count AS',
      'BEGIN',
      '  SELECT COUNT(*) FROM dbo.f_script;',
      'END',
      'GO',
      'IF (SELECT COUNT(*) FROM dbo.f_script) = 3 INSERT INTO dbo.f_script VALUES (100); ELSE INSERT INTO dbo.f_script VALUES (-1);',
      'EXEC dbo.f_count;',
      'DROP PROCEDURE dbo.f_count',
      'GO',
      '',
    ].join('\n');
    const report = await new ScriptRunner({
      manager: manager(),
      logger: new RecordingLogger(),
    }).run({
      target: { connectionId: 'c' },
      chunks: parts(script),
      continueOnError: false,
    });
    expect(report.stoppedAt, JSON.stringify(report.stoppedAt)).toBeUndefined();
    expect(report).toMatchObject({ outcome: 'done', failedCount: 0, statements: 7 });
    expect(firstColumn(await runAll(session, 'SELECT n FROM dbo.f_script ORDER BY n'))).toEqual([
      0, 1, 2, 100,
    ]);
  });

  it('names the line a failed batch starts on', async () => {
    const report = await new ScriptRunner({
      manager: manager(),
      logger: new RecordingLogger(),
    }).run({
      target: { connectionId: 'c' },
      chunks: parts('SELECT 1;\nGO\n\nSELECT * FROM dbo.no_such;\nGO\n'),
      continueOnError: false,
    });
    expect(report.outcome).toBe('stopped');
    expect(report.stoppedAt).toMatchObject({ line: 4 });
  });
});

describe('affected rows', () => {
  it('counts the statement, not what its trigger wrote elsewhere', async () => {
    await runAll(session, 'DROP TABLE IF EXISTS dbo.f_people, dbo.f_audit');
    await runAll(session, 'CREATE TABLE dbo.f_audit (n INT)');
    await runAll(session, 'CREATE TABLE dbo.f_people (id INT PRIMARY KEY, name NVARCHAR(20))');
    await runAll(
      session,
      'CREATE TRIGGER dbo.f_people_audit ON dbo.f_people AFTER UPDATE AS INSERT INTO dbo.f_audit SELECT id FROM inserted',
    );
    await runAll(session, "INSERT INTO dbo.f_people VALUES (1, N'a'), (2, N'b')");
    const update = await runAll(session, "UPDATE dbo.f_people SET name = N'c' WHERE id = 1");
    expect(update.done.affectedRows).toBe(1);
    expect(firstColumn(await runAll(session, 'SELECT COUNT(*) FROM dbo.f_audit'))).toEqual([1]);
  });
});

describe('importing files', () => {
  const table = { schema: 'dbo', name: 'f_people' };
  const CSV: ImportOptions = {
    format: 'csv',
    delimiter: ',',
    header: true,
    emptyIsNull: true,
    nullText: '\\N',
  };

  beforeEach(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS dbo.f_people');
    await runAll(
      session,
      `CREATE TABLE dbo.f_people (id INT IDENTITY PRIMARY KEY, name NVARCHAR(50) NOT NULL,
         born DATE, score DECIMAL(6,2), active BIT, note NVARCHAR(MAX))`,
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
      driver: 'mssql',
      file,
      columns: (await session.metadata.describeTable(table)).columns,
      readChunks: (path) => readTextChunks(path, 16),
      importer: new TableImporter({ manager: manager(), logger: new RecordingLogger() }),
    });
    const { mapping } = await model.load(options);
    return await model.run(options, mapping, mode);
  }

  it('imports CSV with identity values, leaving out a row that does not fit', async () => {
    const csv = [
      'id,name,born,score,active,note',
      '1,Anna,2000-01-31,12.50,true,"Line one\nline two"',
      '2,"O\'Brien, Bob",\\N,,false,"say ""hi"""',
      '3,Ольга,1999-12-31,0.10,1,',
      '4,Bad Date,1999-02-30,1,true,x',
      '',
    ].join('\n');
    const report = await importFile('people.csv', csv, CSV, 'skip');
    expect(report).toMatchObject({ outcome: 'done', read: 4, inserted: 3, failedCount: 1 });
    const rows = (
      await runAll(
        session,
        'SELECT id, name, born, score, active, note FROM dbo.f_people ORDER BY id',
      )
    ).rows;
    expect(rows.map((row) => row[1])).toEqual(['Anna', "O'Brien, Bob", 'Ольга']);
    expect(rows[0]).toEqual([
      1,
      'Anna',
      { kind: 'datetime', text: '2000-01-31' },
      { kind: 'decimal', text: '12.50' },
      true,
      'Line one\nline two',
    ]);
    // Numbering goes on after the imported ids.
    await runAll(session, "INSERT INTO dbo.f_people (name) VALUES (N'next')");
    expect(
      firstColumn(await runAll(session, "SELECT id FROM dbo.f_people WHERE name = N'next'")),
    ).toEqual([4]);
  });

  it('keeps nothing when the server refuses a row in all-or-nothing mode', async () => {
    const report = await importFile('dup.csv', 'id,name\n1,a\n1,b\n', CSV, 'all');
    expect(report.outcome).toBe('stopped');
    expect(firstColumn(await runAll(session, 'SELECT COUNT(*) FROM dbo.f_people'))).toEqual([0]);
  });

  it('imports JSON records, nested objects as text', async () => {
    const json = JSON.stringify([
      { name: 'Json', born: '2001-02-03', score: 99.99, active: true, note: { tags: [1] } },
      { name: 'Nulls', born: null, score: null, active: false },
    ]);
    const report = await importFile('people.json', json, { ...CSV, format: 'json' }, 'all');
    expect(report).toMatchObject({ outcome: 'done', inserted: 2, failedCount: 0 });
    expect(firstColumn(await runAll(session, 'SELECT note FROM dbo.f_people ORDER BY id'))).toEqual(
      ['{"tags":[1]}', null],
    );
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
      sql: 'SELECT id, label, value_mod FROM dbo.big_table ORDER BY id',
      format,
      sink,
      table: { schema: 'dbo', name: 'big_table' },
    });
    await sink.close();
    expect(report.rows).toBe(10_000);
    return readFileSync(path);
  }

  it('writes every row as CSV, JSON, SQL and XLSX', async () => {
    const csv = (await exportTo('csv')).toString('utf8').trim().split(/\r?\n/u);
    expect(csv).toHaveLength(10_001);
    expect(csv[1]).toBe('1,row-00001,1');
    const json = JSON.parse((await exportTo('json')).toString('utf8')) as unknown[];
    expect(json).toHaveLength(10_000);
    const sql = (await exportTo('sql')).toString('utf8');
    expect(sql).toContain('INSERT INTO [dbo].[big_table] ([id], [label], [value_mod]) VALUES');
    const sheet = entryText(unzip(await exportTo('xlsx')), 'xl/worksheets/sheet1.xml');
    expect(sheet.match(/<row /gu)).toHaveLength(10_001);
  });
});

describe('generated test data', () => {
  beforeAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS dbo.td_people, dbo.td_teams');
    await runAll(
      session,
      'CREATE TABLE dbo.td_teams (id INT IDENTITY PRIMARY KEY, name NVARCHAR(20))',
    );
    await runAll(session, "INSERT INTO dbo.td_teams (name) VALUES (N'a'), (N'b'), (N'c')");
    await runAll(
      session,
      `CREATE TABLE dbo.td_people (id INT IDENTITY PRIMARY KEY, email NVARCHAR(60) NOT NULL UNIQUE,
         team_id INT NOT NULL REFERENCES dbo.td_teams (id), born DATE, score DECIMAL(5,2),
         active BIT, code CHAR(4), level TINYINT, token UNIQUEIDENTIFIER, seen DATETIMEOFFSET,
         doubled AS (team_id * 2))`,
    );
  });

  async function model(): Promise<TestDataModel> {
    const table = { schema: 'dbo', name: 'td_people' };
    return new TestDataModel({
      target: { connectionId: 'c' },
      table,
      driver: 'mssql',
      dialect: driver.dialect,
      structure: await session.metadata.describeTable(table),
      session: () => Promise.resolve(session),
      importer: new TableImporter({ manager: manager(), logger: new RecordingLogger() }),
    });
  }

  it('inserts rows that fit every column and key', async () => {
    const generator = await model();
    const report = await generator.run(generator.initialState('t').choices, 500, 12345);
    expect(report).toMatchObject({ outcome: 'done', inserted: 500, failedCount: 0 });
    expect(
      firstColumn(await runAll(session, 'SELECT COUNT(DISTINCT email) FROM dbo.td_people')),
    ).toEqual([500]);
    const teams = firstColumn(await runAll(session, 'SELECT DISTINCT team_id FROM dbo.td_people'));
    expect(teams.every((id) => [1, 2, 3].includes(Number(id)))).toBe(true);
  });

  it('keeps nothing when the same seed breaks the unique key', async () => {
    const generator = await model();
    const report = await generator.run(generator.initialState('t').choices, 500, 12345);
    expect(report).toMatchObject({ outcome: 'stopped', rolledBack: true });
    expect(firstColumn(await runAll(session, 'SELECT COUNT(*) FROM dbo.td_people'))).toEqual([500]);
  });

  it('writes a script that runs as it is', async () => {
    const generator = await model();
    const script = await generator.script(generator.initialState('t').choices, 50, 777);
    for (const statement of script.split(';\n').filter((text) => text.trim() !== '')) {
      await runAll(session, statement);
    }
    expect(firstColumn(await runAll(session, 'SELECT COUNT(*) FROM dbo.td_people'))).toEqual([550]);
  });
});
