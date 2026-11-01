import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ObjectScope,
  TableInfo,
  TableRef,
} from '../../../src/core/model/objects';
import type {
  DriverCapabilities,
  ExecuteEvent,
  ExecuteOptions,
  Session,
} from '../../../src/drivers/driver';
import {
  AI_CELL_LIMIT,
  AI_ROW_LIMIT,
  AI_TABLE_LIMIT,
  AI_TEXT_LIMIT,
  AI_TOOL_NAMES,
  AiTools,
} from '../../../src/services/ai-tools';
import type { CellValue } from '../../../src/shared/cell-value';
import type { ConnectionConfig } from '../../../src/shared/connection';

const mysql: ConnectionConfig = {
  id: 'c-mysql',
  name: 'Shop',
  driver: 'mysql',
  host: 'db.internal',
  user: 'root',
  database: 'shop',
};
const pg: ConnectionConfig = {
  id: 'c-pg',
  name: 'Analytics',
  driver: 'postgres',
  host: 'pg.internal',
  user: 'ann',
  database: 'dw',
  production: true,
};
const lite: ConnectionConfig = { id: 'c-lite', name: 'Notes', driver: 'sqlite', file: '/n.db' };
const off: ConnectionConfig = { ...lite, id: 'c-off', name: 'Old', disabled: true };
const redis: ConnectionConfig = { id: 'c-redis', name: 'Cache', driver: 'redis', host: 'r' };
const twin1: ConnectionConfig = { ...lite, id: 'c-t1', name: 'Twin' };
const twin2: ConnectionConfig = { ...lite, id: 'c-t2', name: 'twin' };

const caps = (databases: boolean, schemas: boolean): DriverCapabilities =>
  ({ databases, schemas }) as DriverCapabilities;

interface Script {
  columns?: string[];
  batches?: CellValue[][][];
  fail?: Error;
  hang?: boolean;
}

class FakeSession {
  readonly executed: { sql: string; options: ExecuteOptions | undefined }[] = [];
  cancelled = 0;
  script: Script = { columns: ['n'], batches: [[[1]]] };
  tables: TableInfo[] = [{ name: 'orders', kind: 'table' }];
  columns: ColumnInfo[] = [
    { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
    { name: 'note', dataType: 'text', nullable: true, primaryKey: false, defaultValue: "''" },
  ];
  readonly scopes: ObjectScope[] = [];
  readonly metadata = {
    listDatabases: () => Promise.resolve(['shop', 'other']),
    listSchemas: () => Promise.resolve(['public', 'audit']),
    listTables: (scope: ObjectScope) => {
      this.scopes.push(scope);
      return Promise.resolve(this.tables);
    },
    listColumns: (_table: TableRef) => Promise.resolve(this.columns),
    listForeignKeys: (): Promise<ForeignKey[]> =>
      Promise.resolve([
        {
          name: 'fk',
          columns: ['user_id'],
          target: { name: 'users' },
          targetColumns: ['id'],
        },
      ]),
    listIndexes: (): Promise<IndexInfo[]> =>
      Promise.resolve([
        { name: 'PRIMARY', columns: ['id'], unique: true, primary: true },
        { name: 'by_note', columns: ['note'], unique: false, primary: false },
        { name: 'uniq', columns: ['id', 'note'], unique: true, primary: false },
      ]),
  };

  async *execute(sql: string, options?: ExecuteOptions): AsyncIterable<ExecuteEvent> {
    this.executed.push({ sql, options });
    if (this.script.fail !== undefined) {
      throw this.script.fail;
    }
    if (this.script.hang === true) {
      await new Promise<never>(() => undefined);
    }
    yield { kind: 'columns', columns: (this.script.columns ?? []).map((name) => ({ name })) };
    for (const rows of this.script.batches ?? []) {
      yield { kind: 'rows', rows };
    }
    yield { kind: 'done' };
  }

  cancel(): Promise<void> {
    this.cancelled += 1;
    return Promise.resolve();
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function setup(
  options: { enabled?: () => boolean; timeoutMs?: number; configs?: ConnectionConfig[] } = {},
) {
  const session = new FakeSession();
  const asked: { kind: 'browse' | 'query'; connection: string; database?: string }[] = [];
  const capabilities: Record<string, DriverCapabilities> = {
    'c-mysql': caps(true, false),
    'c-pg': caps(true, true),
    'c-lite': caps(false, false),
  };
  const tools = new AiTools({
    store: { list: () => options.configs ?? [mysql, pg, lite, off, redis] },
    enabled: options.enabled ?? (() => true),
    capabilitiesOf: (id) => Promise.resolve(capabilities[id] ?? caps(false, false)),
    browse: (connection, database) => {
      asked.push({ kind: 'browse', connection, ...(database === undefined ? {} : { database }) });
      return Promise.resolve(session as unknown as Session);
    },
    query: (connection, database) => {
      asked.push({ kind: 'query', connection, ...(database === undefined ? {} : { database }) });
      return Promise.resolve(session as unknown as Session);
    },
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  });
  return { tools, session, asked };
}

describe('AiTools.listConnections', () => {
  it('lists what a model needs and never a host, user or password', () => {
    const { tools } = setup();
    const text = tools.listConnections().text;
    const list = JSON.parse(text) as Record<string, unknown>[];
    expect(list.map((entry) => entry.name)).toEqual(['Shop', 'Analytics', 'Notes', 'Old', 'Cache']);
    expect(list[1]).toEqual({
      id: 'c-pg',
      name: 'Analytics',
      driver: 'postgres',
      kind: 'sql',
      database: 'dw',
      production: true,
    });
    expect(list[3]).toMatchObject({ disabled: true });
    expect(list[4]).toMatchObject({ kind: 'redis' });
    for (const secret of ['db.internal', 'root', 'pg.internal', 'ann', '/n.db']) {
      expect(text).not.toContain(secret);
    }
  });

  it('says no while the setting is off', () => {
    const { tools } = setup({ enabled: () => false });
    expect(tools.listConnections().refused).toBe(true);
  });
});

describe('connection lookup', () => {
  it('finds a connection by id and by name in any case', () => {
    const { tools } = setup();
    expect('config' in tools.resolve('c-mysql')).toBe(true);
    expect('config' in tools.resolve('  shop ')).toBe(true);
    expect('config' in tools.resolve('SHOP')).toBe(true);
  });

  it('refuses an unknown name and points to the list', () => {
    const resolved = setup().tools.resolve('nope');
    expect('refusal' in resolved && resolved.refusal.text).toContain('datanest_listConnections');
  });

  it('refuses a name two connections share, and takes either by id', () => {
    const { tools } = setup({ configs: [twin1, twin2] });
    const resolved = tools.resolve('twin');
    expect('refusal' in resolved && resolved.refusal.text).toContain('Several');
    expect('config' in tools.resolve('c-t2')).toBe(true);
  });

  it('refuses a switched-off connection', () => {
    const resolved = setup().tools.resolve('Old');
    expect('refusal' in resolved && resolved.refusal.refused).toBe(true);
    expect('refusal' in resolved && resolved.refusal.text).toContain('switched off');
  });

  it('refuses a connection that is not SQL', () => {
    const resolved = setup().tools.resolve('Cache');
    expect('refusal' in resolved && resolved.refusal.text).toContain('not a SQL database');
  });

  it('refuses everything while the setting is off', () => {
    const resolved = setup({ enabled: () => false }).tools.resolve('Shop');
    expect('refusal' in resolved).toBe(true);
  });
});

describe('AiTools.listTables', () => {
  it('lists the tables of the default database', async () => {
    const { tools, session, asked } = setup();
    session.tables = [
      { name: 'orders', kind: 'table' },
      { name: 'v_sales', kind: 'view' },
    ];
    const answer = JSON.parse((await tools.listTables({ connection: 'Shop' })).text) as unknown;
    expect(answer).toEqual({
      tables: [
        { name: 'orders', kind: 'table' },
        { name: 'v_sales', kind: 'view' },
      ],
    });
    expect(asked).toEqual([{ kind: 'browse', connection: 'c-mysql', database: 'shop' }]);
    expect(session.scopes).toEqual([{ database: 'shop' }]);
  });

  it('lists the databases when a server with several has none chosen', async () => {
    const { tools } = setup({ configs: [{ ...mysql, database: undefined }] });
    const answer = JSON.parse((await tools.listTables({ connection: 'Shop' })).text) as {
      databases: string[];
    };
    expect(answer.databases).toEqual(['shop', 'other']);
  });

  it('lists the schemas when a database with schemas has none chosen', async () => {
    const { tools } = setup();
    const answer = JSON.parse((await tools.listTables({ connection: 'Analytics' })).text) as {
      schemas: string[];
    };
    expect(answer.schemas).toEqual(['public', 'audit']);
  });

  it('lists the tables once the schema is named', async () => {
    const { tools, session } = setup();
    await tools.listTables({ connection: 'Analytics', schema: 'public', database: 'dw2' });
    expect(session.scopes).toEqual([{ database: 'dw2', schema: 'public' }]);
  });

  it('works on a file database with no database or schema', async () => {
    const { tools, session, asked } = setup();
    await tools.listTables({ connection: 'Notes', database: 'ignored' });
    expect(asked).toEqual([{ kind: 'browse', connection: 'c-lite' }]);
    expect(session.scopes).toEqual([{}]);
  });

  it('cuts a very long list and says so', async () => {
    const { tools, session } = setup();
    session.tables = Array.from({ length: AI_TABLE_LIMIT + 5 }, (_, i) => ({
      name: `t${String(i)}`,
      kind: 'table' as const,
    }));
    const answer = JSON.parse((await tools.listTables({ connection: 'Shop' })).text) as {
      tables: unknown[];
      truncated: boolean;
      total: number;
    };
    expect(answer.tables).toHaveLength(AI_TABLE_LIMIT);
    expect(answer).toMatchObject({ truncated: true, total: AI_TABLE_LIMIT + 5 });
  });

  it('refuses before touching a session', async () => {
    const { tools, asked } = setup();
    expect((await tools.listTables({ connection: 'Old' })).refused).toBe(true);
    expect(asked).toEqual([]);
  });
});

describe('AiTools.describeTable', () => {
  it('describes columns, foreign keys and indexes', async () => {
    const { tools } = setup();
    const answer = JSON.parse(
      (await tools.describeTable({ connection: 'Shop', table: 'orders' })).text,
    ) as Record<string, unknown>;
    expect(answer).toEqual({
      table: 'orders',
      columns: [
        { name: 'id', type: 'int', nullable: false, primaryKey: true },
        { name: 'note', type: 'text', nullable: true, default: "''" },
      ],
      foreignKeys: [{ columns: ['user_id'], references: { table: 'users', columns: ['id'] } }],
      indexes: [
        { name: 'PRIMARY', columns: ['id'], primary: true },
        { name: 'by_note', columns: ['note'] },
        { name: 'uniq', columns: ['id', 'note'], unique: true },
      ],
    });
  });

  it('says so when the table is not there', async () => {
    const { tools, session } = setup();
    session.columns = [];
    const answer = await tools.describeTable({ connection: 'Shop', table: 'ghost' });
    expect(answer.refused).toBe(true);
    expect(answer.text).toContain('ghost');
  });

  it('refuses a connection it may not use', async () => {
    const { tools } = setup();
    expect((await tools.describeTable({ connection: 'Cache', table: 'x' })).refused).toBe(true);
  });
});

describe('AiTools.runReadOnlyQuery', () => {
  it('runs a SELECT in its own session and returns the rows as JSON', async () => {
    const { tools, session, asked } = setup();
    session.script = {
      columns: ['id', 'name', 'qty'],
      batches: [
        [
          [1, 'ann', null],
          [2, 'bob', { kind: 'decimal', text: '1.50' }],
        ],
      ],
    };
    const answer = await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT * FROM t' });
    expect(JSON.parse(answer.text)).toEqual({
      columns: ['id', 'name', 'qty'],
      rows: [
        [1, 'ann', null],
        [2, 'bob', '1.50'],
      ],
      rowCount: 2,
    });
    expect(asked).toEqual([{ kind: 'query', connection: 'c-mysql', database: 'shop' }]);
    expect(session.executed).toEqual([
      { sql: 'SELECT * FROM t', options: { rowLimit: AI_ROW_LIMIT + 1 } },
    ]);
  });

  it('accepts a trailing semicolon and SHOW, EXPLAIN and WITH … SELECT', async () => {
    const { tools, session } = setup();
    for (const sql of [
      'SELECT 1;',
      'SHOW TABLES',
      'EXPLAIN SELECT 1',
      'WITH x AS (SELECT 1) SELECT * FROM x',
    ]) {
      expect((await tools.runReadOnlyQuery({ connection: 'Shop', sql })).refused).toBeUndefined();
    }
    expect(session.executed).toHaveLength(4);
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'UPDATE t SET a = 1',
    'DELETE FROM t',
    'DROP TABLE t',
    'CREATE TABLE x (a int)',
    'TRUNCATE t',
    'SELECT * INTO copy FROM t',
    'SELECT * FROM t FOR UPDATE',
    'WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d',
    'GRANT ALL ON t TO u',
    'SET GLOBAL x = 1',
  ])('refuses %s and runs nothing', async (sql) => {
    const { tools, session, asked } = setup();
    const answer = await tools.runReadOnlyQuery({ connection: 'Shop', sql });
    expect(answer.refused).toBe(true);
    expect(session.executed).toEqual([]);
    expect(asked).toEqual([]);
  });

  it('refuses a second statement hidden behind a semicolon', async () => {
    const { tools, session } = setup();
    const answer = await tools.runReadOnlyQuery({
      connection: 'Shop',
      sql: 'SELECT 1; DROP TABLE users',
    });
    expect(answer.refused).toBe(true);
    expect(answer.text).toContain('exactly one');
    expect(session.executed).toEqual([]);
  });

  it('refuses an empty statement', async () => {
    const { tools } = setup();
    expect(
      (await tools.runReadOnlyQuery({ connection: 'Shop', sql: '  -- nothing\n' })).refused,
    ).toBe(true);
  });

  it('does not run a write that hides in a comment or a string as a read', async () => {
    const { tools, session } = setup();
    const answer = await tools.runReadOnlyQuery({
      connection: 'Shop',
      sql: "SELECT 'DROP TABLE t' /* DELETE FROM t */",
    });
    expect(answer.refused).toBeUndefined();
    expect(session.executed).toHaveLength(1);
  });

  it('refuses a switched-off, a non-SQL and an unknown connection', async () => {
    const { tools, session } = setup();
    for (const connection of ['Old', 'Cache', 'nope']) {
      expect((await tools.runReadOnlyQuery({ connection, sql: 'SELECT 1' })).refused).toBe(true);
    }
    expect(session.executed).toEqual([]);
  });

  it('passes the database the model named, and none for a file database', async () => {
    const { tools, asked } = setup();
    await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT 1', database: 'other' });
    await tools.runReadOnlyQuery({ connection: 'Notes', sql: 'SELECT 1', database: 'x' });
    expect(asked).toEqual([
      { kind: 'query', connection: 'c-mysql', database: 'other' },
      { kind: 'query', connection: 'c-lite' },
    ]);
  });

  it('stops at 100 rows, says so and cancels the rest', async () => {
    const { tools, session } = setup();
    const rows = Array.from({ length: AI_ROW_LIMIT + 1 }, (_, i): CellValue[] => [i]);
    session.script = { columns: ['n'], batches: [rows.slice(0, 60), rows.slice(60)] };
    const answer = JSON.parse(
      (await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT n FROM t' })).text,
    ) as { rowCount: number; truncated: boolean; note: string };
    expect(answer.rowCount).toBe(AI_ROW_LIMIT);
    expect(answer.truncated).toBe(true);
    expect(answer.note).toContain('100');
    expect(session.cancelled).toBe(1);
  });

  it('does not cancel a statement that finished by itself', async () => {
    const { tools, session } = setup();
    await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT 1' });
    expect(session.cancelled).toBe(0);
  });

  it('cuts long cells', async () => {
    const { tools, session } = setup();
    session.script = { columns: ['t'], batches: [[['x'.repeat(AI_CELL_LIMIT * 3)]]] };
    const answer = JSON.parse(
      (await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT t FROM t' })).text,
    ) as { rows: string[][] };
    expect(answer.rows[0]?.[0]).toHaveLength(AI_CELL_LIMIT + 1);
    expect(answer.rows[0]?.[0]?.endsWith('…')).toBe(true);
  });

  it('keeps an answer within the size limit by dropping rows from the end', async () => {
    const { tools, session } = setup();
    const wide = 'y'.repeat(AI_CELL_LIMIT);
    const rows = Array.from({ length: AI_ROW_LIMIT }, (): CellValue[] => [wide, wide, wide]);
    session.script = { columns: ['a', 'b', 'c'], batches: [rows] };
    const text = (await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT * FROM t' }))
      .text;
    expect(text.length).toBeLessThanOrEqual(AI_TEXT_LIMIT);
    const answer = JSON.parse(text) as {
      rowCount: number;
      rows: unknown[];
      truncated: boolean;
      note: string;
    };
    expect(answer.rowCount).toBe(answer.rows.length);
    expect(answer.rowCount).toBeLessThan(AI_ROW_LIMIT);
    expect(answer.truncated).toBe(true);
    expect(answer.note).toContain('fit');
  });

  it('shows binary values as hex and booleans as they are', async () => {
    const { tools, session } = setup();
    session.script = {
      columns: ['b', 'ok'],
      batches: [[[{ kind: 'binary', size: 2, preview: 'cafe' }, true]]],
    };
    const answer = JSON.parse(
      (await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT b FROM t' })).text,
    ) as { rows: unknown[][] };
    expect(answer.rows).toEqual([['0xcafe', true]]);
  });

  it('answers a statement that returns no rows with its columns', async () => {
    const { tools, session } = setup();
    session.script = { columns: ['n'], batches: [] };
    const answer = JSON.parse(
      (await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT n FROM t WHERE 1=0' })).text,
    ) as { rowCount: number; rows: unknown[] };
    expect(answer).toMatchObject({ rowCount: 0, rows: [] });
  });

  it('reports a failing statement as a refusal with the server message', async () => {
    const { tools, session } = setup();
    session.script = { fail: new Error('no such table: t') };
    const answer = await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT * FROM t' });
    expect(answer.refused).toBe(true);
    expect(answer.text).toContain('no such table: t');
  });

  it('refuses everything while the setting is off', async () => {
    const { tools, session } = setup({ enabled: () => false });
    expect((await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT 1' })).refused).toBe(
      true,
    );
    expect(session.executed).toEqual([]);
  });
});

describe('AiTools.runReadOnlyQuery timeout', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('cancels a statement that runs too long and says so', async () => {
    const { tools, session } = setup({ timeoutMs: 5000 });
    session.script = { hang: true };
    const pending = tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT sleep(99)' });
    await vi.advanceTimersByTimeAsync(5000);
    const answer = await pending;
    expect(answer.refused).toBe(true);
    expect(answer.text).toContain('5 seconds');
    expect(session.cancelled).toBe(1);
  });

  it('does not leave a timer behind after a quick statement', async () => {
    const { tools } = setup({ timeoutMs: 5000 });
    await tools.runReadOnlyQuery({ connection: 'Shop', sql: 'SELECT 1' });
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('AiTools.confirmationFor', () => {
  it('always asks before a query, and shows the statement', () => {
    const { tools } = setup();
    expect(
      tools.confirmationFor(AI_TOOL_NAMES.runReadOnlyQuery, {
        connection: 'Shop',
        sql: 'SELECT 1',
      }),
    ).toEqual({ connection: 'Shop', production: false, sql: 'SELECT 1' });
  });

  it('marks a production connection', () => {
    const { tools } = setup();
    expect(
      tools.confirmationFor(AI_TOOL_NAMES.runReadOnlyQuery, {
        connection: 'Analytics',
        sql: 'SELECT 1',
      }),
    ).toMatchObject({ production: true });
  });

  it('asks about a structure read only on production', () => {
    const { tools } = setup();
    expect(tools.confirmationFor(AI_TOOL_NAMES.listTables, { connection: 'Shop' })).toBeUndefined();
    expect(tools.confirmationFor(AI_TOOL_NAMES.describeTable, { connection: 'Analytics' })).toEqual(
      {
        connection: 'Analytics',
        production: true,
      },
    );
  });

  it('asks nothing before the list of connections, or about a connection that will be refused', () => {
    const { tools } = setup();
    expect(tools.confirmationFor(AI_TOOL_NAMES.listConnections, {})).toBeUndefined();
    expect(
      tools.confirmationFor(AI_TOOL_NAMES.runReadOnlyQuery, { connection: 'nope', sql: 'x' }),
    ).toBeUndefined();
    expect(tools.confirmationFor(AI_TOOL_NAMES.listTables, {})).toBeUndefined();
  });

  it('shows no statement when none was sent', () => {
    const { tools } = setup();
    expect(tools.confirmationFor(AI_TOOL_NAMES.runReadOnlyQuery, { connection: 'Shop' })).toEqual({
      connection: 'Shop',
      production: false,
    });
  });
});

describe('AiTools.schemaDigest', () => {
  it('writes one line per table with column types and keys', async () => {
    const { tools, session } = setup();
    session.tables = [
      { name: 'orders', kind: 'table' },
      { name: 'v_sales', kind: 'view' },
    ];
    expect(await tools.schemaDigest({ connection: 'Shop' })).toBe(
      ['orders(id int pk, note text)', 'v_sales (view)(id int pk, note text)'].join('\n'),
    );
  });

  it('cuts long tables and wide ones', async () => {
    const { tools, session } = setup();
    session.tables = Array.from({ length: 60 }, (_, i) => ({
      name: `t${String(i)}`,
      kind: 'table' as const,
    }));
    session.columns = Array.from({ length: 50 }, (_, i) => ({
      name: `c${String(i)}`,
      dataType: 'int',
      nullable: true,
      primaryKey: false,
    }));
    const lines = (await tools.schemaDigest({ connection: 'Shop' })).split('\n');
    expect(lines).toHaveLength(40);
    expect(lines[0]).toContain(', …)');
  });

  it('is empty when the scope is unknown, or the connection unusable', async () => {
    const { tools } = setup();
    expect(await tools.schemaDigest({ connection: 'Analytics' })).toBe('');
    expect(await tools.schemaDigest({ connection: 'Old' })).toBe('');
    const noDatabase = setup({ configs: [{ ...mysql, database: undefined }] });
    expect(await noDatabase.tools.schemaDigest({ connection: 'Shop' })).toBe('');
  });

  it('reads a schema once it is named', async () => {
    const { tools, session } = setup();
    expect(await tools.schemaDigest({ connection: 'Analytics', schema: 'public' })).toContain(
      'orders(',
    );
    expect(session.scopes).toEqual([{ database: 'dw', schema: 'public' }]);
  });
});
