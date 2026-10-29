// Oracle through the production services (V2–V3 on V6.4): a query result is edited and
// saved, a table is opened, filtered, sorted and paged, the designer's DDL and the
// tree's actions run on the real server, and edited definitions replace the old ones.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import type { Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/oracle';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { QueryRunner } from '../../../src/services/query-runner';
import { ResultEditor } from '../../../src/services/result-editor';
import { ResultSaver } from '../../../src/services/result-saver';
import { ResultStore } from '../../../src/services/result-store';
import { SchemaActions } from '../../../src/services/schema-actions';
import { designFromStructure } from '../../../src/services/table-structure';
import { TableViewer } from '../../../src/services/table-view';
import { cellText } from '../../../src/shared/cell-text';
import type { CellValue } from '../../../src/shared/cell-value';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import type { TableDesign } from '../../../src/shared/table-design';
import type { TableFilter } from '../../../src/shared/table-filter';
import { ORACLE_SERVICE, testDatabase } from '../../helpers/databases';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

const SHOP = 'DATANEST';
const SCRATCH = 'DATANEST_EMPTY';
const DOC = 'untitled:Oracle-1.sql';

function config(): ResolvedConnectionConfig {
  const db = testDatabase('oracle');
  return {
    id: 'oracle-features',
    name: 'oracle',
    driver: 'oracle',
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: ORACLE_SERVICE,
  };
}

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
        table.kind === 'view'
          ? table.materialized === true
            ? 'materialized-view'
            : 'view'
          : 'table',
      ),
    );
  }
}

beforeAll(async () => {
  session = await driver.openSession(config());
  await emptyScratch();
});

afterAll(async () => {
  await emptyScratch();
  await runAll(
    session,
    "BEGIN EXECUTE IMMEDIATE 'DROP TABLE edit_people'; EXCEPTION WHEN OTHERS THEN NULL; END;",
  );
  await session.close();
});

describe('data on Oracle', () => {
  let manager: ConnectionManager;
  let results: ResultStore;
  let runner: QueryRunner;
  let editor: ResultEditor;
  let saver: ResultSaver;
  let viewer: TableViewer;
  let connectionId: string;

  beforeAll(async () => {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    manager = new ConnectionManager({
      store,
      drivers: { get: () => Promise.resolve(driver) },
      logger,
    });
    results = new ResultStore();
    const cache = new MetadataCache({ logger });
    runner = new QueryRunner({ manager, results, cache, limits: { rowLimit: () => 1000 }, logger });
    editor = new ResultEditor(results);
    saver = new ResultSaver({
      manager,
      results,
      isBusy: (uri) => runner.isRunning(uri),
      rowLimit: () => 1000,
      logger,
    });
    viewer = new TableViewer({ manager, results, cache, limits: { pageSize: () => 3 }, logger });
    const db = testDatabase('oracle');
    connectionId = (
      await store.add(
        {
          name: 'oracle',
          driver: 'oracle',
          host: db.host,
          port: db.port,
          user: db.user,
          database: ORACLE_SERVICE,
        },
        db.password,
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
      statements: splitStatements(text, 'oracle'),
    });
    const failed = outcome.results.find((result) => result.error !== undefined);
    if (failed?.error !== undefined) {
      throw new Error(`${text} → ${failed.error.message}`);
    }
    return outcome.results;
  }

  async function load(select: string): Promise<string> {
    const [result] = await sql(select, DOC);
    if (result === undefined) {
      throw new Error('no result');
    }
    return result.id;
  }

  async function rowsOf(select: string): Promise<CellValue[][]> {
    const id = await load(select);
    return results.window(id, 0, 1000)?.rows.map((row) => [...row]) ?? [];
  }

  async function reset(): Promise<void> {
    await sql(
      "BEGIN EXECUTE IMMEDIATE 'DROP TABLE edit_people'; EXCEPTION WHEN OTHERS THEN NULL; END;",
    );
    await sql(
      `CREATE TABLE edit_people (id NUMBER(10) GENERATED BY DEFAULT ON NULL AS IDENTITY PRIMARY KEY,
         name NVARCHAR2(50), age NUMBER(5), born DATE, active BOOLEAN,
         note VARCHAR2(20) DEFAULT 'none' NOT NULL)`,
    );
    await sql(
      `INSERT INTO edit_people (name, age, born, active) VALUES ('alice', 30, DATE '1994-05-06', TRUE);
       INSERT INTO edit_people (name, age, born, active) VALUES ('bob', NULL, NULL, FALSE);
       INSERT INTO edit_people (name, age, born, active) VALUES ('carol', 41, DATE '1983-01-02', TRUE);
       INSERT INTO edit_people (name, age, born, active) VALUES ('50%_off', 8, NULL, NULL);
       INSERT INTO edit_people (name, age, born, active) VALUES (N'Ünï', 12, NULL, TRUE)`,
    );
  }

  describe('editing', () => {
    it('saves edited cells: text, NULL, a DATE with its time, a boolean and DEFAULT', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      const edit = results.get(id)?.edit;
      expect(edit).toMatchObject({ editable: true, keyColumns: ['ID'] });
      // Oracle's DATE holds a time of day: it is edited as a moment, not as a day.
      expect(edit?.editable === true && edit.columns[3]?.kind).toBe('datetime');
      expect(editor.editCell(id, 0, 1, { kind: 'text', text: 'Al\'ice "q" 🚀' })).toEqual({
        ok: true,
      });
      expect(editor.editCell(id, 0, 2, { kind: 'null' })).toEqual({ ok: true });
      expect(editor.editCell(id, 1, 3, { kind: 'text', text: '2000-02-29 13:45:10' })).toEqual({
        ok: true,
      });
      expect(editor.editCell(id, 1, 4, { kind: 'text', text: 'true' })).toEqual({ ok: true });
      expect(editor.editCell(id, 2, 5, { kind: 'default' })).toEqual({ ok: true });
      expect(await saver.save(id)).toMatchObject({ ok: true, statements: 3, refreshed: true });

      const rows = await rowsOf(
        'SELECT name, age, born, active, note FROM edit_people ORDER BY id',
      );
      expect(rows[0]?.slice(0, 2)).toEqual(['Al\'ice "q" 🚀', null]);
      expect(cellText(rows[1]?.[2] ?? null)).toBe('2000-02-29 13:45:10');
      expect(rows[1]?.[3]).toBe(true);
      expect(rows[2]?.[4]).toBe('none');
    });

    it('inserts, duplicates and deletes rows; identity keys come back from the server', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.rowAction(id, 'add', []);
      editor.editCell(id, 5, 1, { kind: 'text', text: 'dave' });
      editor.rowAction(id, 'duplicate', [0]);
      editor.rowAction(id, 'delete', [1]);
      expect(await saver.save(id)).toMatchObject({ ok: true, statements: 3 });
      const rows = await rowsOf('SELECT name FROM edit_people ORDER BY id');
      expect(rows.map((row) => row[0])).toEqual([
        'alice',
        'carol',
        '50%_off',
        'Ünï',
        'dave',
        'alice',
      ]);
      expect((results.window(id, 0, 10)?.rows ?? []).every((row) => row[0] !== null)).toBe(true);
    });

    it('rolls everything back when the server refuses one statement', async () => {
      await reset();
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.editCell(id, 0, 1, { kind: 'text', text: 'saved?' });
      // Longer than NVARCHAR2(50): refused by the server after the first update went through.
      editor.editCell(id, 1, 1, { kind: 'text', text: 'x'.repeat(60) });
      expect(await saver.save(id)).toMatchObject({ ok: false, code: 'constraint' });
      const rows = await rowsOf('SELECT name FROM edit_people ORDER BY id');
      expect(rows.slice(0, 2).map((row) => row[0])).toEqual(['alice', 'bob']);
    });

    it('saves inside an open transaction with a savepoint, leaving it open', async () => {
      await reset();
      await sql('SET TRANSACTION READ WRITE', DOC);
      const id = await load('SELECT * FROM edit_people ORDER BY id');
      editor.editCell(id, 0, 1, { kind: 'text', text: 'in transaction' });
      const preview = await saver.preview(id);
      expect(preview).toMatchObject({ ok: true });
      expect(preview.ok && preview.sql).toContain('SAVEPOINT datanest_save;');
      expect(await saver.save(id)).toMatchObject({ ok: true, inTransaction: true });
      expect(manager.transactionState(ConnectionManager.editorOwner(DOC))).toBe('open');
      await sql('ROLLBACK', DOC);
      expect((await rowsOf('SELECT name FROM edit_people ORDER BY id'))[0]?.[0]).toBe('alice');
    });

    it('edits a table named in lower case with its schema, the way Oracle reads it', async () => {
      await reset();
      const id = await load('SELECT * FROM datanest.edit_people ORDER BY id');
      expect(results.get(id)?.edit).toMatchObject({
        editable: true,
        table: { schema: SHOP, name: 'EDIT_PEOPLE' },
      });
      editor.editCell(id, 0, 1, { kind: 'text', text: 'renamed' });
      expect(await saver.save(id)).toMatchObject({ ok: true });
      expect((await rowsOf('SELECT name FROM edit_people ORDER BY id'))[0]?.[0]).toBe('renamed');
    });

    it('keeps a joined result read-only', async () => {
      const id = await load(
        'SELECT c.email, o.status FROM customers c JOIN orders o ON o.customer_id = c.id',
      );
      expect(results.get(id)?.edit?.editable).toBe(false);
    });
  });

  describe('table view', () => {
    const table = { schema: SHOP, name: 'CUSTOMERS' };

    async function names(
      filter?: TableFilter,
      sort?: { column: string; direction: 'asc' | 'desc' },
      offset = 0,
    ) {
      const summary = await viewer.open({
        target: { connectionId },
        table,
        offset,
        ...(filter === undefined ? {} : { filter }),
        ...(sort === undefined ? {} : { sort }),
      });
      expect(summary.error).toBeUndefined();
      const column = summary.columns.findIndex((c) => c.name === 'FULL_NAME');
      return {
        summary,
        names: (results.window(summary.id, 0, 100)?.rows ?? []).map((row) =>
          cellText(row[column] ?? null),
        ),
      };
    }

    it('pages through the table, sorted either way', async () => {
      const first = await names(undefined, { column: 'ID', direction: 'asc' });
      expect(first.names).toEqual(['Alice Johnson', "Bob O'Brien", 'Ольга Иванова']);
      expect(first.summary.page).toMatchObject({ offset: 0, pageSize: 3 });
      const next = await names(undefined, { column: 'ID', direction: 'asc' }, 3);
      expect(next.names).toEqual(['山田 博', '']);
      const last = await names(undefined, { column: 'ID', direction: 'desc' });
      expect(last.names[0]).toBe('');
      expect(first.summary.edit?.editable).toBe(true);
    });

    it('filters regardless of case, with % and _ as plain characters, and dates as ISO text', async () => {
      const contains = (column: string, value: string): TableFilter => ({
        conditions: [{ column, operator: 'contains', value }],
      });
      expect((await names(contains('FULL_NAME', 'ALICE'))).names).toEqual(['Alice Johnson']);
      expect((await names(contains('FULL_NAME', 'иван'))).names).toEqual(['Ольга Иванова']);
      expect((await names(contains('EMAIL', 'a_ice'))).names).toEqual([]);
      expect((await names(contains('FULL_NAME', "o'b"))).names).toEqual(["Bob O'Brien"]);
      // The session formats dates as DataNest shows them, so a filter finds them that way.
      expect(
        (await names(contains('CREATED_AT', '2024-01-0'), { column: 'ID', direction: 'asc' }))
          .names,
      ).toEqual(['Alice Johnson', "Bob O'Brien"]);
      expect(
        (await names({ conditions: [{ column: 'FULL_NAME', operator: 'isNull' }] })).summary.page
          ?.totalRows,
      ).toBe(1);
    });

    it('filters a CLOB longer than 4000 characters', async () => {
      await sql(
        "BEGIN EXECUTE IMMEDIATE 'DROP TABLE edit_people'; EXCEPTION WHEN OTHERS THEN NULL; END;",
      );
      await sql('CREATE TABLE edit_people (id NUMBER PRIMARY KEY, body CLOB)');
      await sql(
        `INSERT INTO edit_people SELECT 1, TO_CLOB(RPAD('x', 4000, 'x')) || TO_CLOB(RPAD('y', 4000, 'y')) || 'Needle' FROM dual`,
      );
      const summary = await viewer.open({
        target: { connectionId },
        table: { schema: SHOP, name: 'EDIT_PEOPLE' },
        offset: 0,
        filter: { conditions: [{ column: 'BODY', operator: 'contains', value: 'NEEDLE' }] },
      });
      expect(summary.error).toBeUndefined();
      expect(summary.page?.totalRows).toBe(1);
    });
  });

  it('reads names written in lower case, as Oracle does without quotes', async () => {
    const columns = await session.metadata.listColumns({ schema: 'datanest', name: 'customers' });
    expect(columns[0]).toMatchObject({ name: 'ID', primaryKey: true });
    const [definition] = await session.metadata.getDefinition({ kind: 'table', name: 'orders' });
    expect(definition).toMatch(/^CREATE TABLE "DATANEST"\."ORDERS"/u);
    expect((await session.metadata.listTables({ schema: 'inventory' })).map((t) => t.name)).toEqual(
      ['STOCK_LEVELS', 'WAREHOUSES'],
    );
  });
});

describe('structure changes on Oracle', () => {
  const { ddl } = driver.dialect;
  const SCOPE = { schema: SCRATCH };
  /** createTable takes the scope from a reference; the name comes from the design. */
  const HERE = { schema: SCRATCH, name: '' };

  async function each(statements: readonly string[]): Promise<void> {
    for (const statement of statements) {
      await runAll(session, statement);
    }
  }

  beforeEach(async () => {
    await emptyScratch();
  });

  const people: TableDesign = {
    name: 'ST_PEOPLE',
    comment: "People, with a quote: '",
    columns: [
      {
        id: 'c1',
        name: 'ID',
        type: 'NUMBER',
        length: '10',
        nullable: false,
        defaultValue: '',
        autoIncrement: true,
        primaryKey: true,
        comment: '',
      },
      {
        id: 'c2',
        name: 'EMAIL',
        type: 'VARCHAR2',
        length: '120 CHAR',
        nullable: false,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: false,
        comment: 'Login',
      },
      {
        id: 'c3',
        name: 'SCORE',
        type: 'NUMBER',
        length: '6,2',
        nullable: true,
        defaultValue: '0',
        autoIncrement: false,
        primaryKey: false,
        comment: '',
      },
      {
        id: 'c4',
        name: 'JOINED',
        type: 'TIMESTAMP',
        length: '0',
        nullable: true,
        defaultValue: 'SYSTIMESTAMP',
        autoIncrement: false,
        primaryKey: false,
        comment: '',
      },
    ],
    indexes: [{ id: 'i1', name: 'UX_ST_PEOPLE_EMAIL', columns: ['c2'], unique: true }],
    foreignKeys: [],
  };

  const child: TableDesign = {
    name: 'ST_CHILD',
    comment: '',
    columns: [
      {
        id: 'k1',
        name: 'ID',
        type: 'NUMBER',
        length: '10',
        nullable: false,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: true,
        comment: '',
      },
      {
        id: 'k2',
        name: 'PERSON_ID',
        type: 'NUMBER',
        length: '10',
        nullable: true,
        defaultValue: '',
        autoIncrement: false,
        primaryKey: false,
        comment: '',
      },
    ],
    indexes: [],
    foreignKeys: [
      {
        id: 'f1',
        name: 'FK_ST_CHILD_PERSON',
        columns: ['k2'],
        targetTable: 'ST_PEOPLE',
        targetColumns: ['ID'],
        onDelete: 'CASCADE',
        onUpdate: 'CASCADE',
      },
    ],
  };

  async function load(name: string) {
    const table = { ...SCOPE, name };
    return designFromStructure(table, await session.metadata.describeTable(table));
  }

  it('creates designed tables: identity, defaults, a unique index, comments and a foreign key', async () => {
    await each(ddl.createTable(HERE, people));
    await each(ddl.createTable(HERE, child));
    const structure = await session.metadata.describeTable({ ...SCOPE, name: 'ST_PEOPLE' });
    expect(structure.columns.map((column) => [column.name, column.dataType])).toEqual([
      ['ID', 'NUMBER(10)'],
      ['EMAIL', 'VARCHAR2(120 CHAR)'],
      ['SCORE', 'NUMBER(6,2)'],
      ['JOINED', 'TIMESTAMP(0)'],
    ]);
    expect(structure.columns[0]?.autoIncrement).toBe(true);
    expect(structure.columns[2]?.defaultExpression).toBe('0');
    expect(structure.comment).toBe("People, with a quote: '");
    expect(structure.columns[1]?.comment).toBe('Login');
    expect(structure.indexes.find((index) => index.name === 'UX_ST_PEOPLE_EMAIL')).toMatchObject({
      unique: true,
      columns: ['EMAIL'],
    });
    const keys = await session.metadata.listForeignKeys({ ...SCOPE, name: 'ST_CHILD' });
    // Oracle has no ON UPDATE: the designer's CASCADE there is dropped, not refused.
    expect(keys.map((key) => [key.name, key.columns, key.target.name, key.onDelete])).toEqual([
      ['FK_ST_CHILD_PERSON', ['PERSON_ID'], 'ST_PEOPLE', 'CASCADE'],
    ]);
    await runAll(session, `INSERT INTO ${SCRATCH}.st_people (email) VALUES ('a@b.c')`);
    expect(firstColumn(await runAll(session, `SELECT id FROM ${SCRATCH}.st_people`))).toEqual([1]);
  });

  it('alters a loaded table change by change: rename, retype, defaults, comments, keys', async () => {
    await each(ddl.createTable(HERE, people));
    await runAll(session, `INSERT INTO ${SCRATCH}.st_people (email, score) VALUES ('a@b.c', 1.5)`);
    const loaded = await load('ST_PEOPLE');
    const before = loaded.design;
    const nick = {
      id: 'new-1',
      name: 'NICK',
      type: 'NVARCHAR2',
      length: '40',
      nullable: true,
      defaultValue: "'none'",
      autoIncrement: false,
      primaryKey: false,
      comment: 'Nickname',
    };
    const after: TableDesign = {
      ...before,
      name: 'ST_RENAMED',
      comment: '',
      columns: [
        ...before.columns.map((column) =>
          column.name === 'EMAIL'
            ? { ...column, name: 'MAIL', comment: '' }
            : column.name === 'SCORE'
              ? { ...column, length: '8,3', nullable: false, defaultValue: '' }
              : column,
        ),
        nick,
      ],
      indexes: [],
    };
    const plan = ddl.alterTable({ ...SCOPE, name: 'ST_PEOPLE' }, before, after, loaded.background);
    await each(plan.statements);
    const structure = await session.metadata.describeTable({ ...SCOPE, name: 'ST_RENAMED' });
    expect(
      structure.columns.map((column) => [
        column.name,
        column.dataType,
        column.nullable,
        column.defaultExpression,
        column.comment,
      ]),
    ).toEqual([
      ['ID', 'NUMBER(10)', false, undefined, undefined],
      ['MAIL', 'VARCHAR2(120 CHAR)', false, undefined, undefined],
      ['SCORE', 'NUMBER(8,3)', false, undefined, undefined],
      ['JOINED', 'TIMESTAMP(0)', true, 'SYSTIMESTAMP', undefined],
      ['NICK', 'NVARCHAR2(40)', true, "'none'", 'Nickname'],
    ]);
    expect(structure.comment).toBeUndefined();
    expect(structure.indexes.map((index) => index.name)).not.toContain('UX_ST_PEOPLE_EMAIL');
    expect(firstColumn(await runAll(session, `SELECT score FROM ${SCRATCH}.st_renamed`))).toEqual([
      { kind: 'decimal', text: '1.5' },
    ]);

    const reloaded = await load('ST_RENAMED');
    const identityOff = {
      ...reloaded.design,
      columns: reloaded.design.columns.map((column) =>
        column.name === 'ID' ? { ...column, autoIncrement: false } : column,
      ),
    };
    expect(() =>
      ddl.alterTable(
        { ...SCOPE, name: 'ST_RENAMED' },
        reloaded.design,
        identityOff,
        reloaded.background,
      ),
    ).toThrow(/identity/u);
  });

  it('changes the primary key and adds a foreign key to an existing table', async () => {
    await each(ddl.createTable(HERE, people));
    await each(ddl.createTable(HERE, { ...child, foreignKeys: [] }));
    const loaded = await load('ST_CHILD');
    const after: TableDesign = {
      ...loaded.design,
      columns: loaded.design.columns.map((column) => ({
        ...column,
        primaryKey: true,
        nullable: false,
      })),
      foreignKeys: [{ ...(child.foreignKeys[0] ?? ({} as never)), columns: ['k2'] }],
    };
    // The loaded design has its own column ids; the key points at the loaded one.
    const personId = loaded.design.columns.find((column) => column.name === 'PERSON_ID')?.id;
    const withKey = {
      ...after,
      foreignKeys: after.foreignKeys.map((key) => ({ ...key, columns: [personId ?? ''] })),
    };
    await each(
      ddl.alterTable({ ...SCOPE, name: 'ST_CHILD' }, loaded.design, withKey, loaded.background)
        .statements,
    );
    const structure = await session.metadata.describeTable({ ...SCOPE, name: 'ST_CHILD' });
    expect(structure.primaryKey).toEqual(['ID', 'PERSON_ID']);
    expect(structure.foreignKeys.map((key) => key.target.name)).toEqual(['ST_PEOPLE']);
  });

  it('renames, truncates and drops tables and views from the tree', async () => {
    await each(ddl.createTable(HERE, people));
    await runAll(session, `INSERT INTO ${SCRATCH}.st_people (email) VALUES ('x')`);
    await runAll(session, ddl.truncateTable({ ...SCOPE, name: 'ST_PEOPLE' }));
    expect(firstColumn(await runAll(session, `SELECT COUNT(*) FROM ${SCRATCH}.st_people`))).toEqual(
      [0],
    );
    await runAll(session, ddl.renameRelation({ ...SCOPE, name: 'ST_PEOPLE' }, 'table', 'ST_X'));
    await runAll(session, `CREATE VIEW ${SCRATCH}.st_view AS SELECT id FROM ${SCRATCH}.st_x`);
    await runAll(session, ddl.dropRelation({ ...SCOPE, name: 'ST_VIEW' }, 'view'));
    await runAll(session, ddl.dropRelation({ ...SCOPE, name: 'ST_X' }, 'table'));
    expect(await session.metadata.listTables(SCOPE)).toEqual([]);
  });

  it('replaces an edited view and procedure, and keeps the old one when the new does not compile', async () => {
    const logger = new RecordingLogger();
    const actions = new SchemaActions({
      manager: {
        driverOf: () => Promise.resolve(driver),
        acquire: () => Promise.resolve(session),
        release: () => Promise.resolve(),
      },
      cache: { invalidate: () => undefined },
      logger,
    });
    await runAll(session, `CREATE TABLE ${SCRATCH}.st_numbers (n NUMBER)`);
    await runAll(session, `INSERT INTO ${SCRATCH}.st_numbers VALUES (1)`);
    await runAll(
      session,
      `CREATE PROCEDURE ${SCRATCH}.st_proc AS BEGIN UPDATE ${SCRATCH}.st_numbers SET n = 2; END;`,
    );
    const proc = { kind: 'procedure' as const, ...SCOPE, name: 'ST_PROC' };
    const original = await session.metadata.getDefinition(proc);
    expect(original[0]).toMatch(/PROCEDURE "DATANEST_EMPTY"\."ST_PROC"/u);
    const edited = `CREATE PROCEDURE ${SCRATCH}.st_proc AS\nBEGIN\n  UPDATE ${SCRATCH}.st_numbers SET n = 3;\nEND;`;
    const action = { kind: 'replaceObject' as const, object: proc, statements: [edited], original };
    await actions.run('c', action, await actions.sqlOf('c', action));
    await runAll(session, `BEGIN ${SCRATCH}.st_proc; END;`);
    expect(firstColumn(await runAll(session, `SELECT n FROM ${SCRATCH}.st_numbers`))).toEqual([3]);

    const broken = {
      ...action,
      statements: [`CREATE PROCEDURE ${SCRATCH}.st_proc AS BEGIN no_such_thing; END;`],
      original: [edited],
    };
    await expect(actions.run('c', broken, await actions.sqlOf('c', broken))).rejects.toMatchObject({
      code: 'syntax',
    });
    // The old text is back and compiles: the procedure still runs.
    await runAll(session, `BEGIN ${SCRATCH}.st_proc; END;`);
    expect(
      firstColumn(
        await runAll(
          session,
          `SELECT status FROM all_objects WHERE owner = '${SCRATCH}' AND object_name = 'ST_PROC'`,
        ),
      ),
    ).toEqual(['VALID']);

    await runAll(session, `CREATE VIEW ${SCRATCH}.st_view AS SELECT 1 AS answer FROM dual`);
    const view = { kind: 'view' as const, ...SCOPE, name: 'ST_VIEW' };
    const viewAction = {
      kind: 'replaceObject' as const,
      object: view,
      statements: [`CREATE VIEW ${SCRATCH}.st_view AS SELECT 2 AS answer FROM dual`],
      original: await session.metadata.getDefinition(view),
    };
    await actions.run('c', viewAction, await actions.sqlOf('c', viewAction));
    expect(firstColumn(await runAll(session, `SELECT answer FROM ${SCRATCH}.st_view`))).toEqual([
      2,
    ]);
  });
});
