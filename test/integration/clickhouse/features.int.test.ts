// ClickHouse through the production services (V2–V5 on V6.3): browsing, filters and
// pages, read-only results, the designer, dumps, imports without transactions, exports,
// test data and copies to and from SQLite.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import type { ObjectScope } from '../../../src/core/model/objects';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as clickhouseDriver } from '../../../src/drivers/clickhouse';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { ConnectionManager, type SessionTarget } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { FileSink } from '../../../src/services/file-sink';
import { TableImporter } from '../../../src/services/import/table-import';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { QueryRunner } from '../../../src/services/query-runner';
import { ResultStore } from '../../../src/services/result-store';
import { type ScriptChunk, ScriptRunner } from '../../../src/services/script-runner';
import { SqlDumper } from '../../../src/services/sql-dump';
import { StreamExporter } from '../../../src/services/stream-export';
import { designFromStructure } from '../../../src/services/table-structure';
import { TableViewer } from '../../../src/services/table-view';
import { readTextChunks } from '../../../src/services/text-file';
import { TableTransferService } from '../../../src/services/transfer/table-transfer';
import { cellText } from '../../../src/shared/cell-text';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import type { ImportOptions } from '../../../src/shared/protocols/data-import';
import type { TableDesign } from '../../../src/shared/table-design';
import type { TableFilter } from '../../../src/shared/table-filter';
import { DataImportModel } from '../../../src/vscode/panels/data-import-model';
import { TestDataModel } from '../../../src/vscode/panels/test-data-model';
import { testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';
import { entryText, unzip } from '../../helpers/unzip';

const SHOP = 'datanest_test';
const SCRATCH = 'datanest_empty';

function config(database = SHOP): ResolvedConnectionConfig {
  const db = testDatabase('clickhouse');
  return {
    id: `ch-${database}`,
    name: 'clickhouse',
    driver: 'clickhouse',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database,
  };
}

/** A manager for task services: every owner gets a session of its own. */
function manager(driverFor: () => Driver = () => clickhouseDriver, configFor = config) {
  const sessions = new Map<string, Session>();
  return {
    driverOf: () => Promise.resolve(driverFor()),
    acquire: async (owner: string, target: SessionTarget) => {
      const session = await driverFor().openSession(configFor(target.database));
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
let worker: BuiltWorker;
let session: Session;

async function emptyScratch(): Promise<void> {
  for (const table of await session.metadata.listTables({ database: SCRATCH })) {
    await runAll(
      session,
      `DROP ${table.kind === 'view' ? 'VIEW' : 'TABLE'} ${SCRATCH}.\`${table.name}\``,
    );
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'datanest-ch-'));
  worker = await buildSqliteWorker();
  session = await clickhouseDriver.openSession(config());
  await emptyScratch();
});

afterAll(async () => {
  await emptyScratch();
  await session.close();
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

describe('browsing', () => {
  let connections: ConnectionManager;
  let results: ResultStore;
  let runner: QueryRunner;
  let viewer: TableViewer;
  let connectionId: string;

  beforeAll(async () => {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    connections = new ConnectionManager({
      store,
      drivers: { get: () => Promise.resolve(clickhouseDriver) },
      logger,
    });
    results = new ResultStore();
    const cache = new MetadataCache({ logger });
    runner = new QueryRunner({
      manager: connections,
      results,
      cache,
      limits: { rowLimit: () => 1000 },
      logger,
    });
    viewer = new TableViewer({
      manager: connections,
      results,
      cache,
      limits: { pageSize: () => 3 },
      logger,
    });
    const db = testDatabase('clickhouse');
    connectionId = (
      await store.add(
        {
          name: 'ch',
          driver: 'clickhouse',
          host: db.host,
          port: db.port,
          user: db.user,
          database: SHOP,
        },
        db.password,
      )
    ).id;
  });

  afterAll(() => {
    connections.dispose();
  });

  async function names(
    filter?: TableFilter,
    sort?: { column: string; direction: 'asc' | 'desc' },
    offset = 0,
  ) {
    const summary = await viewer.open({
      target: { connectionId },
      table: { database: SHOP, name: 'customers' },
      offset,
      ...(filter === undefined ? {} : { filter }),
      ...(sort === undefined ? {} : { sort }),
    });
    expect(summary.error).toBeUndefined();
    const column = summary.columns.findIndex((c) => c.name === 'full_name');
    return {
      summary,
      names: (results.window(summary.id, 0, 100)?.rows ?? []).map((row) =>
        cellText(row[column] ?? null),
      ),
    };
  }

  it('pages through a table with the exact count MergeTree keeps', async () => {
    const first = await names(undefined, { column: 'id', direction: 'asc' });
    expect(first.names).toEqual(['Alice Johnson', "Bob O'Brien", 'Ольга Иванова']);
    expect(first.summary.page).toMatchObject({ offset: 0, pageSize: 3, totalRows: 5 });
    const next = await names(undefined, { column: 'id', direction: 'asc' }, 3);
    expect(next.names).toEqual(['山田 博', '']);
  });

  it('filters regardless of case, with % and _ as plain characters', async () => {
    expect(
      (await names({ conditions: [{ column: 'full_name', operator: 'contains', value: 'ALICE' }] }))
        .names,
    ).toEqual(['Alice Johnson']);
    expect(
      (await names({ conditions: [{ column: 'full_name', operator: 'contains', value: 'иван' }] }))
        .names,
    ).toEqual(['Ольга Иванова']);
    expect(
      (await names({ conditions: [{ column: 'email', operator: 'contains', value: 'a_ice' }] }))
        .names,
    ).toEqual([]);
    expect(
      (await names({ conditions: [{ column: 'full_name', operator: 'contains', value: "o'b" }] }))
        .names,
    ).toEqual(["Bob O'Brien"]);
    expect(
      (await names({ conditions: [{ column: 'full_name', operator: 'isNull' }] })).summary.page
        ?.totalRows,
    ).toBe(1);
  });

  it('shows results read-only: no row can be told apart by a key', async () => {
    const outcome = await runner.run({
      documentUri: 'untitled:Ch.sql',
      target: { connectionId },
      statements: splitStatements('SELECT * FROM customers ORDER BY id', 'clickhouse'),
    });
    expect(outcome.results[0]?.edit?.editable).not.toBe(true);
  });
});

describe('structure', () => {
  const { ddl } = clickhouseDriver.dialect;
  const here = { database: SCRATCH, name: '' };

  async function each(statements: readonly string[]): Promise<void> {
    for (const sql of statements) {
      await runAll(session, sql);
    }
  }

  beforeEach(async () => {
    await emptyScratch();
  });

  const people: TableDesign = {
    name: 'ch_people',
    comment: "People, with a quote: '",
    columns: [
      {
        id: 'c1',
        name: 'id',
        type: 'UInt64',
        length: '',
        nullable: false,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: true,
        comment: '',
      },
      {
        id: 'c2',
        name: 'email',
        type: 'String',
        length: '',
        nullable: false,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: false,
        comment: 'Login',
      },
      {
        id: 'c3',
        name: 'score',
        type: 'Decimal',
        length: '6,2',
        nullable: true,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: false,
        comment: '',
      },
      {
        id: 'c4',
        name: 'tag',
        type: 'LowCardinality(String)',
        length: '',
        nullable: true,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: false,
        comment: '',
      },
      {
        id: 'c5',
        name: 'joined',
        type: 'DateTime',
        length: '',
        nullable: false,
        defaultValue: 'now()',
        autoIncrement: false,
        primaryKey: false,
        comment: '',
      },
    ],
    indexes: [{ id: 'i1', name: 'ix_email', columns: ['c2'], unique: false }],
    foreignKeys: [],
  };

  it('creates a designed table: MergeTree ordered by the key, Nullable columns, comments', async () => {
    await each(ddl.createTable(here, people));
    const columns = await session.metadata.listColumns({ database: SCRATCH, name: 'ch_people' });
    expect(columns.map((column) => [column.name, column.dataType])).toEqual([
      ['id', 'UInt64'],
      ['email', 'String'],
      ['score', 'Nullable(Decimal(6, 2))'],
      ['tag', 'LowCardinality(Nullable(String))'],
      ['joined', 'DateTime'],
    ]);
    const structure = await session.metadata.describeTable({
      database: SCRATCH,
      name: 'ch_people',
    });
    expect(structure.primaryKey).toEqual(['id']);
    expect(structure.comment).toBe("People, with a quote: '");
    expect(structure.columns[1]?.comment).toBe('Login');
    expect(structure.indexes.find((index) => index.name === 'ix_email')?.method).toBe(
      'bloom_filter',
    );
  });

  it('alters a loaded table change by change, keeping the order asked for', async () => {
    await each(ddl.createTable(here, people));
    await runAll(
      session,
      `INSERT INTO ${SCRATCH}.ch_people (id, email, score) VALUES (1, 'a@b.c', 1.5)`,
    );
    const table = { database: SCRATCH, name: 'ch_people' };
    const loaded = designFromStructure(table, await session.metadata.describeTable(table));
    const before = loaded.design;
    const columns = before.columns.map((column) =>
      column.name === 'email'
        ? { ...column, name: 'mail', comment: '' }
        : column.name === 'score'
          ? { ...column, length: '8,3', nullable: false, defaultValue: '0' }
          : column,
    );
    const nick = {
      id: 'new-1',
      name: 'nick',
      type: 'String',
      length: '',
      nullable: true,
      defaultValue: "'none'",
      autoIncrement: false,
      primaryKey: false,
      comment: 'Nickname',
    };
    const after: TableDesign = {
      ...before,
      name: 'ch_renamed',
      comment: '',
      columns: [columns[0], nick, ...columns.slice(1)].filter((c) => c !== undefined),
      indexes: [],
    };
    await each(ddl.alterTable(table, before, after, loaded.background).statements);
    const renamed = await session.metadata.listColumns({ database: SCRATCH, name: 'ch_renamed' });
    expect(renamed.map((column) => [column.name, column.dataType, column.defaultValue])).toEqual([
      ['id', 'UInt64', undefined],
      ['nick', 'Nullable(String)', "'none'"],
      ['mail', 'String', undefined],
      ['score', 'Decimal(8, 3)', '0'],
      ['tag', 'LowCardinality(Nullable(String))', undefined],
      ['joined', 'DateTime', 'now()'],
    ]);
    expect(firstColumn(await runAll(session, `SELECT score FROM ${SCRATCH}.ch_renamed`))).toEqual([
      { kind: 'decimal', text: '1.500' },
    ]);
    expect(
      (await session.metadata.listIndexes({ database: SCRATCH, name: 'ch_renamed' })).map(
        (i) => i.name,
      ),
    ).toEqual(['PRIMARY KEY']);
    const changedKey = {
      ...after,
      columns: after.columns.map((column) => ({ ...column, primaryKey: column.name === 'mail' })),
    };
    expect(() =>
      ddl.alterTable(
        { database: SCRATCH, name: 'ch_renamed' },
        after,
        changedKey,
        loaded.background,
      ),
    ).toThrow(/sorting key/u);
  });

  it('renames, truncates and drops; replaces a view in place', async () => {
    await each(ddl.createTable(here, people));
    await runAll(session, `INSERT INTO ${SCRATCH}.ch_people (id, email) VALUES (1, 'x')`);
    await runAll(session, ddl.truncateTable({ database: SCRATCH, name: 'ch_people' }));
    expect(firstColumn(await runAll(session, `SELECT count() FROM ${SCRATCH}.ch_people`))).toEqual([
      0,
    ]);
    await runAll(
      session,
      ddl.renameRelation({ database: SCRATCH, name: 'ch_people' }, 'table', 'ch_renamed'),
    );
    await runAll(session, `CREATE VIEW ${SCRATCH}.ch_view AS SELECT 1 AS answer`);
    const view = { kind: 'view' as const, database: SCRATCH, name: 'ch_view' };
    const [original] = await session.metadata.getDefinition(view);
    await each(
      ddl.replaceObject(
        view,
        [`CREATE VIEW ${SCRATCH}.ch_view AS SELECT 2 AS answer`],
        [original ?? ''],
      ).statements,
    );
    expect(firstColumn(await runAll(session, `SELECT answer FROM ${SCRATCH}.ch_view`))).toEqual([
      2,
    ]);
    await runAll(session, ddl.dropRelation({ database: SCRATCH, name: 'ch_view' }, 'view'));
    await runAll(session, ddl.dropRelation({ database: SCRATCH, name: 'ch_renamed' }, 'table'));
    expect(await session.metadata.listTables({ database: SCRATCH })).toEqual([]);
  });
});

describe('files', () => {
  beforeEach(async () => {
    await emptyScratch();
  });

  async function* parts(text: string): AsyncGenerator<ScriptChunk> {
    for (let offset = 0; offset < text.length; offset += 4096) {
      await Promise.resolve();
      const piece = text.slice(offset, offset + 4096);
      yield { text: piece, bytes: piece.length };
    }
  }

  it('dumps the shop and loads the script into an empty database', async () => {
    const scope = { database: SHOP };
    const relations = (await session.metadata.listTables(scope)).filter(
      (table) => table.materialized !== true,
    );
    let script = '';
    await new SqlDumper({ manager: manager(), logger: new RecordingLogger() }).dump({
      target: { connectionId: 'c', database: SHOP },
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
    expect(script).toContain('CREATE TABLE customers');
    for (const pass of [1, 2]) {
      const report = await new ScriptRunner({
        manager: manager(),
        logger: new RecordingLogger(),
      }).run({
        target: { connectionId: 'c', database: SCRATCH },
        chunks: parts(script),
        continueOnError: false,
      });
      expect(report.stoppedAt, `pass ${pass}: ${JSON.stringify(report.stoppedAt)}`).toBeUndefined();
    }
    for (const table of [
      'customers',
      'products',
      'orders',
      'order_items',
      'all_types',
      'big_table',
    ]) {
      const rows = async (database: string) =>
        (await runAll(session, `SELECT * FROM ${database}.${table} ORDER BY tuple(*)`)).rows.map(
          (row) => JSON.stringify(row),
        );
      expect(await rows(SCRATCH), table).toEqual(await rows(SHOP));
    }
    // The view was written against the original database's tables, as the server keeps it.
    expect(
      firstColumn(await runAll(session, `SELECT count() FROM ${SCRATCH}.order_totals`)),
    ).toEqual([8]);
  });

  it('imports CSV; all-or-nothing stops at the first bad row but keeps the rows before', async () => {
    await runAll(
      session,
      `CREATE TABLE ${SCRATCH}.ch_import (id UInt32, name String, born Nullable(Date), score Nullable(Decimal(6, 2)), active Bool) ENGINE = MergeTree ORDER BY id`,
    );
    const table = { database: SCRATCH, name: 'ch_import' };
    const run = async (name: string, text: string, mode: 'all' | 'skip') => {
      const file = join(dir, name);
      writeFileSync(file, text);
      const options: ImportOptions = {
        format: 'csv',
        delimiter: ',',
        header: true,
        emptyIsNull: true,
        nullText: '\\N',
      };
      const model = new DataImportModel({
        target: { connectionId: 'c', database: SCRATCH },
        table,
        driver: 'clickhouse',
        transactional: false,
        file,
        columns: (await session.metadata.describeTable(table)).columns,
        readChunks: (path) => readTextChunks(path, 16),
        importer: new TableImporter({ manager: manager(), logger: new RecordingLogger() }),
      });
      expect(model.transactional).toBe(false);
      const { mapping } = await model.load(options);
      return await model.run(options, mapping, mode);
    };
    const csv =
      'id,name,born,score,active\n1,Anna,2000-01-31,12.50,true\n2,Ольга,\\N,,false\n3,Bad,1999-02-30,1,true\n4,After,2001-01-01,2,true\n';
    const stopped = await run('a.csv', csv, 'all');
    expect(stopped).toMatchObject({ outcome: 'stopped', rolledBack: false });
    // Rows go in batches, so the good rows before the bad one were not sent yet.
    expect(stopped.inserted).toBe(0);
    const skipped = await run('b.csv', csv, 'skip');
    expect(skipped).toMatchObject({ outcome: 'done', inserted: 3, failedCount: 1 });
    expect(
      (
        await runAll(
          session,
          `SELECT id, name, born, score, active FROM ${SCRATCH}.ch_import ORDER BY id`,
        )
      ).rows,
    ).toEqual([
      [
        1,
        'Anna',
        { kind: 'datetime', text: '2000-01-31' },
        { kind: 'decimal', text: '12.50' },
        true,
      ],
      [2, 'Ольга', null, null, false],
      [
        4,
        'After',
        { kind: 'datetime', text: '2001-01-01' },
        { kind: 'decimal', text: '2.00' },
        true,
      ],
    ]);
  });

  it('exports a whole table as CSV and XLSX', async () => {
    for (const format of ['csv', 'xlsx'] as const) {
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
        table: { database: SHOP, name: 'big_table' },
      });
      await sink.close();
      expect(report.rows).toBe(10_000);
      if (format === 'csv') {
        expect(readFileSync(path, 'utf8').split(/\r?\n/u)[1]).toBe('1,row-00001,1');
      } else {
        expect(
          entryText(unzip(readFileSync(path)), 'xl/worksheets/sheet1.xml').match(/<row /gu),
        ).toHaveLength(10_001);
      }
    }
  });

  it('generates test data without a transaction', async () => {
    await runAll(
      session,
      `CREATE TABLE ${SCRATCH}.td_people (id UInt64, email String, born Date32, score Decimal(5, 2), active Bool, level UInt8, token UUID, seen DateTime64(3), tag LowCardinality(String), note Nullable(String)) ENGINE = MergeTree ORDER BY id`,
    );
    const table = { database: SCRATCH, name: 'td_people' };
    const generator = new TestDataModel({
      target: { connectionId: 'c', database: SCRATCH },
      table,
      driver: 'clickhouse',
      dialect: clickhouseDriver.dialect,
      structure: await session.metadata.describeTable(table),
      session: () => Promise.resolve(session),
      importer: new TableImporter({ manager: manager(), logger: new RecordingLogger() }),
    });
    const report = await generator.run(generator.initialState('t').choices, 500, 12345);
    expect(report.failures, JSON.stringify(report.failures)).toEqual([]);
    expect(report).toMatchObject({ outcome: 'done', inserted: 500, failedCount: 0 });
    expect(firstColumn(await runAll(session, `SELECT count() FROM ${SCRATCH}.td_people`))).toEqual([
      500,
    ]);
  });
});

describe('copies to and from SQLite', () => {
  const sqlite = () => createSqliteDriver({ workerPath: worker.workerPath });
  const sqliteConfig = (): ResolvedConnectionConfig => ({
    id: 's',
    name: 's',
    driver: 'sqlite',
    file: join(dir, 'shop.db'),
  });

  async function transfer(
    fromSqlite: boolean,
    tables: string[],
    scope: { from: ObjectScope; to: ObjectScope },
  ) {
    const ends = new Map<string, [() => Driver, (database?: string) => ResolvedConnectionConfig]>([
      ['from', fromSqlite ? [sqlite, sqliteConfig] : [() => clickhouseDriver, config]],
      ['to', fromSqlite ? [() => clickhouseDriver, config] : [sqlite, sqliteConfig]],
    ]);
    const sessions = new Map<string, Session>();
    return await new TableTransferService({
      manager: {
        driverOf: (connectionId) => Promise.resolve((ends.get(connectionId)?.[0] ?? sqlite)()),
        acquire: async (owner, target) => {
          const [driverOf, configOf] = ends.get(target.connectionId) ?? [sqlite, sqliteConfig];
          const opened = await driverOf().openSession(configOf(target.database));
          sessions.set(owner, opened);
          return opened;
        },
        release: async (owner) => {
          await sessions.get(owner)?.close();
        },
      },
      logger: new RecordingLogger(),
    }).transfer({
      source: {
        target: {
          connectionId: 'from',
          ...(scope.from.database === undefined ? {} : { database: scope.from.database }),
        },
        scope: scope.from,
      },
      destination: {
        target: {
          connectionId: 'to',
          ...(scope.to.database === undefined ? {} : { database: scope.to.database }),
        },
        scope: scope.to,
      },
      tables,
      content: 'all',
      existing: 'replace',
    });
  }

  it('copies ClickHouse tables into SQLite and back into another database', async () => {
    await emptyScratch();
    const tables = ['customers', 'orders', 'all_types', 'big_table'];
    const out = await transfer(false, tables, { from: { database: SHOP }, to: {} });
    for (const table of out.tables) {
      expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
    }
    const back = await transfer(true, tables, { from: {}, to: { database: SCRATCH } });
    for (const table of back.tables) {
      expect(table.error, `${table.table}: ${table.error ?? ''}`).toBeUndefined();
    }
    const emails = async (database: string) =>
      firstColumn(await runAll(session, `SELECT email FROM ${database}.customers ORDER BY id`));
    expect(await emails(SCRATCH)).toEqual(await emails(SHOP));
    expect(firstColumn(await runAll(session, `SELECT count() FROM ${SCRATCH}.big_table`))).toEqual([
      10_000,
    ]);
    const statuses = firstColumn(
      await runAll(session, `SELECT status FROM ${SCRATCH}.orders ORDER BY id`),
    );
    expect(statuses.slice(0, 3)).toEqual(['paid', 'shipped', 'new']);
  });
});
