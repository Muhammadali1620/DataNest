// Servers that speak MySQL's or PostgreSQL's protocol (V6.5), each through the driver of
// that protocol and the production services: TiDB (MySQL), CockroachDB and YugabyteDB
// (PostgreSQL). The same checks run on all three; what a server lacks is said in the test.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  withoutSystemDatabases,
  withoutSystemSchemas,
} from '../../../src/core/model/system-objects';
import type { ObjectScope } from '../../../src/core/model/objects';
import { splitStatements } from '../../../src/core/sql/split';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { ConnectionManager, type SessionTarget } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { QueryRunner } from '../../../src/services/query-runner';
import { ResultEditor } from '../../../src/services/result-editor';
import { ResultSaver } from '../../../src/services/result-saver';
import { ResultStore } from '../../../src/services/result-store';
import { type ScriptChunk, ScriptRunner } from '../../../src/services/script-runner';
import { SqlDumper } from '../../../src/services/sql-dump';
import { designFromStructure } from '../../../src/services/table-structure';
import { TableViewer } from '../../../src/services/table-view';
import { cellText } from '../../../src/shared/cell-text';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import type { TableDesign } from '../../../src/shared/table-design';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

interface Target {
  readonly id: Extract<TestDatabaseId, 'tidb' | 'cockroach' | 'yugabyte'>;
  readonly driver: Driver;
  /** What version() says, so the server is the one meant. */
  readonly version: RegExp;
  /** Where the shop's tables are, as the session of its database sees them. */
  readonly scope: ObjectScope;
  /** A query that runs long enough to be cancelled. */
  readonly slow: string;
  /** The default an identity or auto-increment column shows in the designer. */
  readonly identityType: string;
}

const TARGETS: readonly Target[] = [
  {
    id: 'tidb',
    driver: mysqlDriver,
    version: /TiDB/u,
    scope: { database: 'datanest_test' },
    slow: 'SELECT id, SLEEP(0.05) FROM big_table ORDER BY id',
    identityType: 'int',
  },
  {
    id: 'cockroach',
    driver: postgresDriver,
    version: /^CockroachDB/u,
    scope: { schema: 'public' },
    slow: 'SELECT count(*) FROM big_table a, big_table b, big_table c',
    // INT is INT8 in CockroachDB.
    identityType: 'bigint',
  },
  {
    id: 'yugabyte',
    driver: postgresDriver,
    version: /-YB-/u,
    scope: { schema: 'public' },
    slow: 'SELECT pg_sleep(30)',
    identityType: 'integer',
  },
];

function configOf(target: Target, database = 'datanest_test'): ResolvedConnectionConfig {
  const db = testDatabase(target.id);
  return {
    id: `compat-${target.id}-${database}`,
    name: target.id,
    driver: target.driver.id,
    host: db.host,
    port: db.port,
    user: db.user,
    ...(db.password === '' ? {} : { password: db.password }),
    database,
  };
}

/** A manager for task services: every owner gets a session of its own. */
function managerOf(target: Target) {
  const sessions = new Map<string, Session>();
  return {
    driverOf: () => Promise.resolve(target.driver),
    acquire: async (owner: string, at: SessionTarget) => {
      const session = await target.driver.openSession(configOf(target, at.database));
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
  for (let offset = 0; offset < text.length; offset += 4096) {
    await Promise.resolve();
    const piece = text.slice(offset, offset + 4096);
    yield { text: piece, bytes: piece.length };
  }
}

describe.each(TARGETS)('$id', (target) => {
  let session: Session;
  let empty: Session;
  const q = (name: string) => target.driver.dialect.quoteIdentifier(name);
  /** The scope of the empty database, as its own session sees it. */
  const emptyScope: ObjectScope =
    target.driver.id === 'mysql' ? { database: 'datanest_empty' } : { schema: 'public' };

  async function emptyTheEmpty(): Promise<void> {
    if (target.driver.id === 'mysql') {
      // Tables go in any order, whatever keys point between them.
      await runAll(empty, 'SET FOREIGN_KEY_CHECKS = 0');
    }
    const tables = await empty.metadata.listTables(emptyScope);
    for (const table of tables.filter((t) => t.kind === 'view')) {
      await runAll(
        empty,
        `DROP VIEW ${target.driver.dialect.quoteTable({ ...emptyScope, name: table.name })}`,
      );
    }
    for (const table of tables.filter((t) => t.kind === 'table')) {
      await runAll(
        empty,
        `DROP TABLE ${target.driver.dialect.quoteTable({ ...emptyScope, name: table.name })}${target.driver.id === 'postgres' ? ' CASCADE' : ''}`,
      );
    }
    if (target.driver.id === 'mysql') {
      await runAll(empty, 'SET FOREIGN_KEY_CHECKS = 1');
    }
  }

  beforeAll(async () => {
    session = await target.driver.openSession(configOf(target));
    empty = await target.driver.openSession(configOf(target, 'datanest_empty'));
    await emptyTheEmpty();
  }, 60_000);

  afterAll(async () => {
    await emptyTheEmpty();
    await session.close();
    await empty.close();
  });

  it('is the server meant, and reads its values', async () => {
    expect(cellText(firstColumn(await runAll(session, 'SELECT version()'))[0] ?? null)).toMatch(
      target.version,
    );
    const result = await runAll(session, 'SELECT * FROM all_types ORDER BY id');
    const names = (result.columnSets[0] ?? []).map((column) => column.name);
    const row = Object.fromEntries(names.map((name, index) => [name, result.rows[0]?.[index]]));
    expect(row).toMatchObject({
      c_bigint: { kind: 'bigint', text: '9223372036854775807' },
      c_varchar: 'O\'Brien "quoted" \\ backslash',
      c_text: 'Многострочный\nтекст',
    });
    expect(cellText(row.c_date ?? null)).toBe('2024-02-29');
    expect(result.rows[1]?.slice(1).every((value) => value === null)).toBe(true);
  });

  it('lists the databases and schemas of the user, without the server’s own', async () => {
    const databases = withoutSystemDatabases(
      target.driver.id,
      await session.metadata.listDatabases(),
    );
    expect(databases).toEqual(expect.arrayContaining(['datanest_test', 'datanest_empty']));
    expect(databases).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^(system|system_platform|metrics_schema)$/iu),
      ]),
    );
    if (target.driver.id === 'postgres') {
      expect(withoutSystemSchemas('postgres', await session.metadata.listSchemas())).toEqual([
        'public',
      ]);
    }
  });

  it('reads tables, columns, keys and indexes', async () => {
    const tables = await session.metadata.listTables(target.scope);
    expect(tables).toEqual(
      expect.arrayContaining([
        { name: 'customers', kind: 'table' },
        { name: 'order_totals', kind: 'view' },
      ]),
    );
    const columns = await session.metadata.listColumns({ ...target.scope, name: 'orders' });
    expect(columns.map((column) => column.name)).toEqual([
      'id',
      'customer_id',
      'status',
      'ordered_at',
      'note',
    ]);
    // An identity column numbers itself; it has no default of its own.
    expect(columns[0]).toMatchObject({ primaryKey: true });
    expect(columns[0]?.defaultValue).toBeUndefined();
    expect(await session.metadata.listUniqueKeys({ ...target.scope, name: 'customers' })).toEqual([
      ['email'],
    ]);
    const keys = await session.metadata.listForeignKeys({ ...target.scope, name: 'order_items' });
    expect(keys.map((key) => [key.columns, key.target.name, key.onDelete]).sort()).toEqual([
      [['order_id'], 'orders', 'CASCADE'],
      [['product_id'], 'products', 'NO ACTION'],
    ]);
    const indexes = await session.metadata.listIndexes({ ...target.scope, name: 'products' });
    expect(indexes.map((index) => index.name)).toContain('ix_products_name');
    const structure = await session.metadata.describeTable({ ...target.scope, name: 'orders' });
    expect(structure.columns[0]).toMatchObject({ name: 'id', autoIncrement: true });
    expect(structure.columns[0]?.defaultExpression).toBeUndefined();
    const { design } = designFromStructure({ ...target.scope, name: 'orders' }, structure);
    expect(design.indexes.map((index) => index.name)).toContain('ix_orders_customer');
  });

  it('reads the definitions of a table and a view that load anywhere', async () => {
    const [table] = await session.metadata.getDefinition({
      kind: 'table',
      ...target.scope,
      name: 'orders',
    });
    expect(table).toMatch(/CREATE TABLE/u);
    const [view] = await session.metadata.getDefinition({
      kind: 'view',
      ...target.scope,
      name: 'order_totals',
    });
    expect(view).toMatch(/VIEW/u);
    // A view tied to the database it came from would not load into another one.
    expect(view).not.toMatch(/datanest_test\.public\./u);
  });

  it('cancels a running statement and stays usable', async () => {
    const run = runAll(session, target.slow);
    const cancelled = expect(run).rejects.toMatchObject({ code: 'cancelled' });
    await new Promise((resolve) => setTimeout(resolve, 700));
    const started = Date.now();
    await session.cancel();
    await cancelled;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(firstColumn(await runAll(session, 'SELECT 3'))).toEqual([3]);
  });

  it('opens transactions with savepoints and rolls them back', async () => {
    const { transaction } = target.driver.dialect;
    await runAll(session, transaction.begin);
    await runAll(session, 'DELETE FROM order_items');
    await runAll(session, transaction.savepoint('sp1'));
    expect(session.transactionState?.()).toBe('open');
    await runAll(session, transaction.rollbackToSavepoint('sp1'));
    await runAll(session, transaction.rollback);
    expect(session.transactionState?.()).toBe('idle');
    expect(firstColumn(await runAll(session, 'SELECT COUNT(*) FROM order_items'))).toEqual([12]);
  });

  describe('through the services', () => {
    let manager: ConnectionManager;
    let results: ResultStore;
    let runner: QueryRunner;
    let editor: ResultEditor;
    let saver: ResultSaver;
    let viewer: TableViewer;
    let connectionId: string;
    const DOC = `untitled:${target.id}.sql`;

    beforeAll(async () => {
      const logger = new RecordingLogger();
      const store = new ConnectionStore({
        state: new FakeMemento(),
        secrets: new FakeSecretStorage(),
        logger,
      });
      manager = new ConnectionManager({
        store,
        drivers: { get: () => Promise.resolve(target.driver) },
        logger,
      });
      results = new ResultStore();
      const cache = new MetadataCache({ logger });
      runner = new QueryRunner({
        manager,
        results,
        cache,
        limits: { rowLimit: () => 1000 },
        logger,
      });
      editor = new ResultEditor(results);
      saver = new ResultSaver({
        manager,
        results,
        isBusy: (uri) => runner.isRunning(uri),
        rowLimit: () => 1000,
        logger,
      });
      viewer = new TableViewer({ manager, results, cache, limits: { pageSize: () => 3 }, logger });
      const config = configOf(target);
      connectionId = (
        await store.add(
          {
            name: target.id,
            driver: target.driver.id,
            host: config.host ?? '',
            ...(config.port === undefined ? {} : { port: config.port }),
            ...(config.user === undefined ? {} : { user: config.user }),
            database: 'datanest_empty',
          },
          config.password,
        )
      ).id;
    }, 60_000);

    afterAll(() => {
      manager.dispose();
    });

    async function sql(text: string, uri = 'untitled:Setup.sql') {
      const outcome = await runner.run({
        documentUri: uri,
        target: { connectionId },
        statements: splitStatements(text, target.driver.id),
      });
      const failed = outcome.results.find((result) => result.error !== undefined);
      if (failed?.error !== undefined) {
        throw new Error(`${text} → ${failed.error.message}`);
      }
      return outcome.results;
    }

    it('edits and saves a result, numbering new rows', async () => {
      await emptyTheEmpty();
      const id =
        target.driver.id === 'mysql'
          ? 'id INT AUTO_INCREMENT PRIMARY KEY'
          : 'id INT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY';
      await sql(`CREATE TABLE edit_people (${id}, name VARCHAR(50), age INT)`);
      await sql("INSERT INTO edit_people (name, age) VALUES ('alice', 30), ('bob', NULL)");
      const [loaded] = await sql('SELECT * FROM edit_people ORDER BY id', DOC);
      const resultId = loaded?.id ?? '';
      expect(results.get(resultId)?.edit).toMatchObject({ editable: true, keyColumns: ['id'] });
      editor.editCell(resultId, 0, 1, { kind: 'text', text: 'Al\'ice "q" 🚀' });
      editor.editCell(resultId, 1, 2, { kind: 'text', text: '41' });
      editor.rowAction(resultId, 'add', []);
      editor.editCell(resultId, 2, 1, { kind: 'text', text: 'carol' });
      expect(await saver.save(resultId)).toMatchObject({ ok: true, statements: 3 });
      const [after] = await sql('SELECT name, age FROM edit_people ORDER BY id', DOC);
      expect((results.window(after?.id ?? '', 0, 10)?.rows ?? []).map((row) => [...row])).toEqual([
        ['Al\'ice "q" 🚀', 30],
        ['bob', 41],
        ['carol', null],
      ]);
    });

    it('pages and filters a table', async () => {
      await emptyTheEmpty();
      await sql('CREATE TABLE people (id INT PRIMARY KEY, full_name VARCHAR(50))');
      await sql(
        "INSERT INTO people VALUES (1, 'Alice Johnson'), (2, 'Bob O''Brien'), (3, 'Ольга Иванова'), (4, '50%_off'), (5, NULL)",
      );
      const open = async (filter?: { value: string }, offset = 0) => {
        const summary = await viewer.open({
          target: { connectionId },
          table: { ...emptyScope, name: 'people' },
          offset,
          sort: { column: 'id', direction: 'asc' },
          ...(filter === undefined
            ? {}
            : {
                filter: {
                  conditions: [{ column: 'full_name', operator: 'contains', value: filter.value }],
                },
              }),
        });
        expect(summary.error).toBeUndefined();
        return {
          summary,
          names: (results.window(summary.id, 0, 10)?.rows ?? []).map((row) =>
            cellText(row[1] ?? null),
          ),
        };
      };
      const first = await open();
      expect(first.names).toEqual(['Alice Johnson', "Bob O'Brien", 'Ольга Иванова']);
      expect(first.summary.page).toMatchObject({ totalRows: 5, pageSize: 3 });
      expect((await open(undefined, 3)).names).toEqual(['50%_off', '']);
      expect((await open({ value: 'ALICE' })).names).toEqual(['Alice Johnson']);
      expect((await open({ value: '%_' })).names).toEqual(['50%_off']);
      expect((await open({ value: "o'b" })).names).toEqual(["Bob O'Brien"]);
    });

    it('creates and alters a designed table', async () => {
      await emptyTheEmpty();
      const { ddl } = target.driver.dialect;
      const design: TableDesign = {
        name: 'st_people',
        comment: '',
        columns: [
          {
            id: 'c1',
            name: 'id',
            type: target.driver.id === 'mysql' ? 'int' : 'integer',
            length: '',
            nullable: false,
            defaultValue: '',
            autoIncrement: true,
            primaryKey: true,
            comment: '',
          },
          {
            id: 'c2',
            name: 'email',
            type: 'varchar',
            length: '120',
            nullable: false,
            defaultValue: '',
            autoIncrement: false,
            primaryKey: false,
            comment: '',
          },
        ],
        indexes: [{ id: 'i1', name: 'ux_st_people_email', columns: ['c2'], unique: true }],
        foreignKeys: [],
      };
      for (const statement of ddl.createTable({ ...emptyScope, name: '' }, design)) {
        await runAll(empty, statement);
      }
      const table = { ...emptyScope, name: 'st_people' };
      const loaded = designFromStructure(table, await empty.metadata.describeTable(table));
      expect(loaded.design.columns.map((column) => [column.name, column.autoIncrement])).toEqual([
        ['id', true],
        ['email', false],
      ]);
      expect(loaded.design.indexes.map((index) => index.name)).toEqual(['ux_st_people_email']);
      const after: TableDesign = {
        ...loaded.design,
        columns: [
          ...loaded.design.columns.map((column) =>
            column.name === 'email' ? { ...column, name: 'mail' } : column,
          ),
          {
            id: 'new',
            name: 'note',
            type: 'varchar',
            length: '20',
            nullable: true,
            defaultValue: "'none'",
            autoIncrement: false,
            primaryKey: false,
            comment: '',
          },
        ],
      };
      const plan = ddl.alterTable(table, loaded.design, after, loaded.background);
      for (const statement of plan.statements) {
        await runAll(empty, statement);
      }
      await runAll(empty, `INSERT INTO ${q('st_people')} (${q('mail')}) VALUES ('a@b.c')`);
      expect(
        (
          await runAll(
            empty,
            `SELECT ${q('id')}, ${q('mail')}, ${q('note')} FROM ${q('st_people')}`,
          )
        ).rows,
      ).toEqual([[1, 'a@b.c', 'none']]);
      expect((await empty.metadata.listColumns(table))[0]?.dataType).toBe(target.identityType);
    });

    it('dumps the shop and loads it into the empty database, twice over', async () => {
      await emptyTheEmpty();
      const relations = await session.metadata.listTables(target.scope);
      let script = '';
      await new SqlDumper({ manager: managerOf(target), logger: new RecordingLogger() }).dump({
        target: { connectionId: 'c', database: 'datanest_test' },
        scope: target.scope,
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
      for (const pass of [1, 2]) {
        const report = await new ScriptRunner({
          manager: managerOf(target),
          logger: new RecordingLogger(),
        }).run({
          target: { connectionId: 'c', database: 'datanest_empty' },
          chunks: parts(script),
          continueOnError: false,
        });
        expect(
          report.stoppedAt,
          `pass ${pass}: ${JSON.stringify(report.stoppedAt)}`,
        ).toBeUndefined();
      }
      for (const table of [
        'customers',
        'products',
        'orders',
        'order_items',
        'all_types',
        'big_table',
      ]) {
        const rows = async (on: Session) =>
          (await runAll(on, `SELECT * FROM ${q(table)}`)).rows
            .map((row) => JSON.stringify(row))
            .sort();
        expect(await rows(empty), table).toEqual(await rows(session));
      }
      expect(firstColumn(await runAll(empty, 'SELECT COUNT(*) FROM order_totals'))).toEqual([8]);
    }, 180_000);
  });
});
