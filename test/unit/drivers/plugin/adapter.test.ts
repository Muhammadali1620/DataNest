import { describe, expect, it } from 'vitest';
import type { PluginDriver, PluginEvent } from '../../../../src/api/types';
import { DbError } from '../../../../src/core/errors';
import {
  createPluginDriver,
  normalizeCell,
  pluginDialect,
  pluginError,
  pluginProblem,
} from '../../../../src/drivers/plugin/adapter';
import type { ExecuteEvent } from '../../../../src/drivers/driver';
import type { CellValue } from '../../../../src/shared/cell-value';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { descriptor, FakePlugin } from '../../../helpers/fake-plugin';

const CONFIG: ResolvedConnectionConfig = {
  id: 'c1',
  name: 'Fake',
  driver: 'plugin',
  plugin: 'acme.fake',
  host: 'db.local',
  port: 4000,
  user: 'ann',
  password: 'secret',
  database: 'main',
  file: '/tmp/x.db',
};

async function run(
  plugin: FakePlugin,
  sql = 'SELECT 1',
  rowLimit?: number,
): Promise<ExecuteEvent[]> {
  const session = await createPluginDriver(plugin).openSession(CONFIG);
  const events: ExecuteEvent[] = [];
  for await (const event of session.execute(sql, rowLimit === undefined ? {} : { rowLimit })) {
    events.push(event);
  }
  return events;
}

describe('normalizeCell', () => {
  it('keeps text, numbers and booleans, and turns undefined and NaN into NULL', () => {
    expect(normalizeCell('a')).toBe('a');
    expect(normalizeCell(1.5)).toBe(1.5);
    expect(normalizeCell(true)).toBe(true);
    expect(normalizeCell(null)).toBeNull();
    expect(normalizeCell(undefined)).toBeNull();
    expect(normalizeCell(Number.NaN)).toBeNull();
    expect(normalizeCell(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps a bigint exact, as a number when it fits and as text when it does not', () => {
    expect(normalizeCell(42n)).toBe(42);
    expect(normalizeCell(9_007_199_254_740_993n)).toEqual({
      kind: 'bigint',
      text: '9007199254740993',
    });
  });

  it('writes a date the way it is spelled in ISO, and drops an invalid date', () => {
    expect(normalizeCell(new Date('2024-02-29T10:00:00Z'))).toEqual({
      kind: 'datetime',
      text: '2024-02-29T10:00:00.000Z',
    });
    expect(normalizeCell(new Date('nope'))).toBeNull();
  });

  it('turns bytes into a binary value with a hex preview', () => {
    expect(normalizeCell(new Uint8Array([0xde, 0xad, 0xbe, 0xef]))).toMatchObject({
      kind: 'binary',
      size: 4,
      preview: 'deadbeef',
    });
  });

  it('lets a plugin hand over the grid kinds as they are', () => {
    expect(normalizeCell({ kind: 'decimal', text: '1.50' })).toEqual({
      kind: 'decimal',
      text: '1.50',
    });
    expect(normalizeCell({ kind: 'json', text: '{}' })).toEqual({ kind: 'json', text: '{}' });
    expect(normalizeCell({ kind: 'datetime', text: '2024-01-01' })).toEqual({
      kind: 'datetime',
      text: '2024-01-01',
    });
    expect(normalizeCell({ kind: 'bigint', text: '5' })).toEqual({ kind: 'bigint', text: '5' });
    expect(normalizeCell({ kind: 'binary', size: 3, preview: 'aabbcc' })).toEqual({
      kind: 'binary',
      size: 3,
      preview: 'aabbcc',
    });
  });

  it('does not trust a tagged value that is built wrong', () => {
    expect(normalizeCell({ kind: 'decimal', text: 5 })).toEqual({
      kind: 'json',
      text: '{"kind":"decimal","text":5}',
    });
    expect(normalizeCell({ kind: 'binary', size: 'big', preview: 1 })).toMatchObject({
      kind: 'json',
    });
  });

  it('shows other objects and arrays as JSON, bigint inside included', () => {
    expect(normalizeCell({ a: 1, n: 2n })).toEqual({ kind: 'json', text: '{"a":1,"n":"2"}' });
    expect(normalizeCell([1, 2])).toEqual({ kind: 'json', text: '[1,2]' });
  });

  it('survives a value that cannot be written as JSON, and what has no value at all', () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(normalizeCell(loop)).toEqual({ kind: 'json', text: '[unserializable]' });
    expect(normalizeCell(() => 1)).toBeNull();
    expect(normalizeCell(Symbol('s'))).toBeNull();
  });
});

describe('pluginError', () => {
  it('keeps a DbError as it is', () => {
    const error = new DbError('timeout', 'slow');
    expect(pluginError(error)).toBe(error);
  });

  it('takes the code and position a plugin set, when they are valid', () => {
    const error = Object.assign(new Error('bad syntax'), { code: 'syntax', position: 7 });
    expect(pluginError(error)).toMatchObject({
      code: 'syntax',
      position: 7,
      message: 'bad syntax',
    });
  });

  it('ignores a code it does not know and a position that is not usable', () => {
    for (const extra of [{ code: 'weird', position: -1 }, { code: 5, position: 1.5 }, {}]) {
      const wrapped = pluginError(Object.assign(new Error('x'), extra));
      expect(wrapped.code).toBe('internal');
      expect(wrapped.position).toBeUndefined();
    }
  });

  it('describes a thrown string or nothing', () => {
    expect(pluginError('boom').message).toBe('boom');
    expect(pluginError(undefined).code).toBe('internal');
  });
});

describe('pluginProblem', () => {
  const ok: PluginDriver = new FakePlugin();

  it('accepts a complete driver', () => {
    expect(pluginProblem(ok)).toBeUndefined();
  });

  it('refuses what is not a driver or lacks a part', () => {
    expect(pluginProblem(null)).toBeDefined();
    expect(pluginProblem({ ...ok, id: 'Bad Id' })).toContain('Bad Id');
    expect(pluginProblem({ ...ok, id: '' })).toBeDefined();
    expect(pluginProblem({ ...ok, id: 'x'.repeat(65) })).toBeDefined();
    expect(pluginProblem({ ...ok, label: '  ' })).toContain('label');
    expect(pluginProblem({ ...ok, fields: 'host' as unknown as [] })).toContain('fields');
    expect(pluginProblem({ id: 'acme.x', label: 'X', fields: [] })).toContain('openSession');
  });
});

describe('pluginDialect', () => {
  it('quotes identifiers with the quote the plugin asked for', () => {
    expect(pluginDialect().quoteIdentifier('a"b')).toBe('"a""b"');
    expect(pluginDialect('`').quoteIdentifier('a`b')).toBe('`a``b`');
    expect(pluginDialect('[').quoteIdentifier('a]b')).toBe('[a]]b]');
  });

  it('refuses an empty name and a NUL', () => {
    expect(() => pluginDialect().quoteIdentifier('')).toThrow();
    expect(() => pluginDialect().quoteIdentifier('a\u0000b')).toThrow();
  });

  it('names a table with its database and schema', () => {
    expect(pluginDialect().quoteTable({ name: 't' })).toBe('"t"');
    expect(pluginDialect().quoteTable({ database: 'd', schema: 's', name: 't' })).toBe(
      '"d"."s"."t"',
    );
  });

  it('writes values as SQL literals', () => {
    const dialect = pluginDialect();
    const literal = (value: CellValue): string => dialect.literal(value);
    expect(literal(null)).toBe('NULL');
    expect(literal(true)).toBe('TRUE');
    expect(literal(false)).toBe('FALSE');
    expect(literal(1.5)).toBe('1.5');
    expect(literal(Number.NaN)).toBe('NULL');
    expect(literal("it's")).toBe("'it''s'");
    expect(literal({ kind: 'bigint', text: '12' })).toBe('12');
    expect(literal({ kind: 'decimal', text: 'abc' })).toBe("'abc'");
    expect(literal({ kind: 'datetime', text: '2024-01-01' })).toBe("'2024-01-01'");
    expect(literal({ kind: 'json', text: '{"a":1}' })).toBe(`'{"a":1}'`);
    expect(literal({ kind: 'binary', size: 2, preview: 'abcd' })).toBe("x'abcd'");
  });

  it('pages with LIMIT and OFFSET and refuses a bad page', () => {
    const dialect = pluginDialect();
    const paginate = (sql: string, limit: number, offset: number): string =>
      dialect.paginate(sql, limit, offset);
    expect(paginate('SELECT 1;', 10, 0)).toBe('SELECT 1 LIMIT 10');
    expect(paginate('SELECT 1', 10, 20)).toBe('SELECT 1 LIMIT 10 OFFSET 20');
    expect(() => paginate('SELECT 1', -1, 0)).toThrow();
    expect(() => paginate('SELECT 1', 1, 1.5)).toThrow();
  });

  it('has the small remaining pieces plain SQL needs', () => {
    const dialect = pluginDialect();
    expect(dialect.likeText('"c"', "'%a%'")).toContain('LIKE');
    expect(dialect.insertDefaultRow('"t"')).toBe('INSERT INTO "t" DEFAULT VALUES');
    expect(dialect.defaultKeyword).toBe(false);
    expect(dialect.transaction.begin).toBe('BEGIN');
  });

  it('cannot change the structure, and says so', () => {
    const { ddl, dump } = pluginDialect();
    expect(() => ddl.dropRelation({ name: 't' }, 'table')).toThrow(/does not support/u);
    expect(() => ddl.renameRelation({ name: 't' }, 'table', 'u')).toThrow();
    expect(() => ddl.truncateTable({ name: 't' })).toThrow();
    expect(() => ddl.dropObject({ kind: 'function', name: 'f' })).toThrow();
    expect(() => ddl.replaceObject({ kind: 'function', name: 'f' }, [], [])).toThrow();
    expect(() => ddl.createTable({ name: 't' }, {} as never)).toThrow();
    expect(() => ddl.alterTable({ name: 't' }, {} as never, {} as never, {} as never)).toThrow();
    expect(ddl.designer.types).toEqual([]);
    expect(dump.insert('"t"', ['"a"'], ['(1)', '(2)'], false)).toBe(
      'INSERT INTO "t" ("a") VALUES\n(1),\n(2)',
    );
    expect(dump.insertSelect('"t"', ['"a"'], 'SELECT 1', false)).toBe(
      'INSERT INTO "t" ("a")\nSELECT 1',
    );
    expect(dump.dropRelations([{ name: 't' }], 'table')).toEqual([]);
    expect(() => dump.dropObject({ kind: 'function', name: 'f' })).toThrow();
  });
});

describe('createPluginDriver', () => {
  it('is a driver of the plugin kind with capabilities from the features', () => {
    const plain = createPluginDriver(new FakePlugin());
    expect(plain.id).toBe('plugin');
    expect(plain.capabilities).toMatchObject({
      databases: false,
      schemas: false,
      cancel: false,
      transactions: false,
      objectKinds: [],
    });
    const rich = createPluginDriver({
      ...descriptor(),
      id: 'acme.rich',
      label: 'Rich',
      fields: [],
      openSession: () => Promise.reject(new Error('unused')),
      features: { databases: true, schemas: true, cancel: true },
    });
    expect(rich.capabilities).toMatchObject({ databases: true, schemas: true, cancel: true });
  });

  it('hands the connection to the plugin without the fields it does not have', async () => {
    const plugin = new FakePlugin();
    await createPluginDriver(plugin).openSession({ ...CONFIG, readOnly: true });
    expect(plugin.opened[0]).toEqual({
      host: 'db.local',
      port: 4000,
      user: 'ann',
      password: 'secret',
      database: 'main',
      file: '/tmp/x.db',
      readOnly: true,
    });
    await createPluginDriver(plugin).openSession({
      id: 'c2',
      name: 'Bare',
      driver: 'plugin',
      plugin: 'acme.fake',
    });
    expect(plugin.opened[1]).toEqual({ readOnly: false });
  });

  it('turns a failure to open into a DbError', async () => {
    const plugin = new FakePlugin();
    plugin.failWith = Object.assign(new Error('no route'), { code: 'connection-failed' });
    await expect(createPluginDriver(plugin).openSession(CONFIG)).rejects.toMatchObject({
      name: 'DbError',
      code: 'connection-failed',
      message: 'no route',
    });
  });

  it('refuses a session that is not complete', async () => {
    const broken: PluginDriver = {
      id: 'acme.broken',
      label: 'B',
      fields: [],
      openSession: () => Promise.resolve({ close: () => Promise.resolve() } as never),
    };
    await expect(createPluginDriver(broken).openSession(CONFIG)).rejects.toMatchObject({
      code: 'internal',
    });
    const nothing: PluginDriver = { ...broken, openSession: () => Promise.resolve(null as never) };
    await expect(createPluginDriver(nothing).openSession(CONFIG)).rejects.toMatchObject({
      code: 'internal',
    });
  });
});

describe('a plugin session', () => {
  it('runs a statement and passes columns, rows and done on', async () => {
    const plugin = new FakePlugin({
      events: () => [
        { kind: 'columns', columns: [{ name: 'a', dataType: 'int' }, { name: 'b' }] },
        {
          kind: 'rows',
          rows: [
            [1, 'x'],
            [2, 'y'],
          ],
        },
        { kind: 'rows', rows: [[3, 'z']] },
        { kind: 'done', affectedRows: 3, notice: 'ok' },
      ],
    });
    const events = await run(plugin);
    expect(events).toEqual([
      { kind: 'columns', columns: [{ name: 'a', dataType: 'int' }, { name: 'b' }] },
      {
        kind: 'rows',
        rows: [
          [1, 'x'],
          [2, 'y'],
        ],
      },
      { kind: 'rows', rows: [[3, 'z']] },
      { kind: 'done', affectedRows: 3, notice: 'ok' },
    ]);
    expect(plugin.sessions[0]?.executed).toEqual(['SELECT 1']);
  });

  it('adds the done event a plugin forgot', async () => {
    const plugin = new FakePlugin({
      events: () => [{ kind: 'columns', columns: [{ name: 'a' }] }],
    });
    expect(await run(plugin)).toEqual([
      { kind: 'columns', columns: [{ name: 'a' }] },
      { kind: 'done' },
    ]);
  });

  it('stops at the first done, whatever follows', async () => {
    const plugin = new FakePlugin({
      events: () => [{ kind: 'done' }, { kind: 'rows', rows: [[1]] }],
    });
    expect(await run(plugin)).toEqual([{ kind: 'done' }]);
  });

  it('normalizes cells and fits each row to the columns', async () => {
    const plugin = new FakePlugin({
      events: () => [
        { kind: 'columns', columns: [{ name: 'a' }, { name: 'b' }] },
        { kind: 'rows', rows: [[1], [1, 2, 3], [undefined, 5n]] },
      ],
    });
    const events = await run(plugin);
    expect(events[1]).toEqual({
      kind: 'rows',
      rows: [
        [1, null],
        [1, 2],
        [null, 5],
      ],
    });
  });

  it('names a column that has no name and drops a type that is not text', async () => {
    const plugin = new FakePlugin({
      events: () => [
        {
          kind: 'columns',
          columns: [{ name: '' }, { name: 'b', dataType: 5 }, null] as never,
        },
      ],
    });
    expect((await run(plugin))[0]).toEqual({
      kind: 'columns',
      columns: [{ name: 'column1' }, { name: 'b' }, { name: 'column3' }],
    });
  });

  it('cuts the rows at the limit and stops reading', async () => {
    let batches = 0;
    const plugin = new FakePlugin({
      events: () => {
        batches += 1;
        return [
          { kind: 'rows', rows: [[1], [2], [3]] },
          { kind: 'rows', rows: [[4], [5]] },
          { kind: 'done' },
        ];
      },
    });
    const events = await run(plugin, 'SELECT *', 4);
    expect(events).toEqual([
      { kind: 'rows', rows: [[1], [2], [3]] },
      { kind: 'rows', rows: [[4]] },
      { kind: 'done' },
    ]);
    expect(batches).toBe(1);
    expect(plugin.sessions[0]?.executeOptions[0]).toEqual({ rowLimit: 4 });
  });

  it('stops exactly when the limit is reached by a whole batch', async () => {
    const plugin = new FakePlugin({
      events: () => [
        { kind: 'rows', rows: [[1], [2]] },
        { kind: 'rows', rows: [[3]] },
      ],
    });
    expect(await run(plugin, 'SELECT *', 2)).toEqual([
      { kind: 'rows', rows: [[1], [2]] },
      { kind: 'done' },
    ]);
  });

  it('does not ask the plugin for a limit when there is none', async () => {
    const plugin = new FakePlugin();
    await run(plugin);
    expect(plugin.sessions[0]?.executeOptions[0]).toBeUndefined();
  });

  it('refuses events and rows it cannot read', async () => {
    const bad: PluginEvent[][] = [
      [{ kind: 'mystery' } as never],
      [null as never],
      [{ kind: 'columns', columns: 'a' } as never],
      [{ kind: 'columns', columns: Array.from({ length: 10_001 }, () => ({ name: 'a' })) }],
      [{ kind: 'rows', rows: 'a' } as never],
      [{ kind: 'columns', columns: [{ name: 'a' }] }, { kind: 'rows', rows: ['x'] } as never],
    ];
    for (const events of bad) {
      await expect(run(new FakePlugin({ events: () => events }))).rejects.toMatchObject({
        name: 'DbError',
        code: 'internal',
      });
    }
  });

  it('keeps only usable counts and notices in done', async () => {
    for (const [event, expected] of [
      [{ kind: 'done', affectedRows: -1, notice: '' }, { kind: 'done' }],
      [{ kind: 'done', affectedRows: 1.5 }, { kind: 'done' }],
      [
        { kind: 'done', affectedRows: 0, notice: 'n' },
        { kind: 'done', affectedRows: 0, notice: 'n' },
      ],
    ] as const) {
      expect(await run(new FakePlugin({ events: () => [event] }))).toEqual([expected]);
    }
  });

  it('turns an error thrown while running into a DbError with the plugin code', async () => {
    const plugin = new FakePlugin({
      events: () => {
        throw Object.assign(new Error('near "x"'), { code: 'syntax', position: 5 });
      },
    });
    await expect(run(plugin)).rejects.toMatchObject({
      name: 'DbError',
      code: 'syntax',
      position: 5,
      message: 'near "x"',
    });
  });

  it('cancels through the plugin when it can, and does nothing when it cannot', async () => {
    const withCancel = new FakePlugin({ withCancel: true });
    const session = await createPluginDriver(withCancel).openSession(CONFIG);
    await session.cancel();
    expect(withCancel.sessions[0]?.cancelled).toBe(1);
    const without = new FakePlugin();
    const other = await createPluginDriver(without).openSession(CONFIG);
    await expect(other.cancel()).resolves.toBeUndefined();
  });

  it('does not let a failing cancel escape, and does not cancel after close', async () => {
    const plugin = new FakePlugin({ withCancel: true });
    const session = await createPluginDriver(plugin).openSession(CONFIG);
    const inner = plugin.sessions[0];
    if (inner !== undefined) {
      inner.cancel = () => Promise.reject(new Error('no'));
    }
    await expect(session.cancel()).resolves.toBeUndefined();
    await session.close();
    await session.cancel();
    expect(inner?.cancelled).toBe(0);
  });

  it('closes the plugin session once, and survives a close that fails', async () => {
    const plugin = new FakePlugin();
    const session = await createPluginDriver(plugin).openSession(CONFIG);
    await session.close();
    await session.close();
    expect(plugin.sessions[0]?.closed).toBe(1);
    const failing = new FakePlugin();
    const other = await createPluginDriver(failing).openSession(CONFIG);
    const inner = failing.sessions[0];
    if (inner !== undefined) {
      inner.close = () => Promise.reject(new Error('gone'));
    }
    await expect(other.close()).resolves.toBeUndefined();
  });
});

describe('the metadata of a plugin session', () => {
  async function metadataOf(plugin: FakePlugin) {
    return (await createPluginDriver(plugin).openSession(CONFIG)).metadata;
  }

  it('lists tables and columns with the defaults a plugin may leave out', async () => {
    const metadata = await metadataOf(new FakePlugin());
    expect(await metadata.listTables({})).toEqual([
      { name: 'people', kind: 'table' },
      { name: 'v', kind: 'view' },
    ]);
    expect(await metadata.listColumns({ name: 'people' })).toEqual([
      { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
      { name: 'name', dataType: 'text', nullable: true, primaryKey: false },
    ]);
  });

  it('keeps a column default and drops entries that have no name', async () => {
    const metadata = await metadataOf(
      new FakePlugin({
        metadata: {
          listTables: () => Promise.resolve([{ name: '' }, { name: 'ok' }, null] as never),
          listColumns: () =>
            Promise.resolve([
              { name: 'a', dataType: 'int', defaultValue: '0' },
              { name: '', dataType: 'int' },
              { name: 'b' },
            ] as never),
        },
      }),
    );
    expect(await metadata.listTables({})).toEqual([{ name: 'ok', kind: 'table' }]);
    expect(await metadata.listColumns({ name: 't' })).toEqual([
      { name: 'a', dataType: 'int', nullable: true, primaryKey: false, defaultValue: '0' },
      { name: 'b', dataType: '', nullable: true, primaryKey: false },
    ]);
  });

  it('survives a plugin that answers with something that is not a list', async () => {
    const metadata = await metadataOf(
      new FakePlugin({
        metadata: {
          listTables: () => Promise.resolve('x' as never),
          listColumns: () => Promise.resolve(undefined as never),
          listDatabases: () => Promise.resolve([1, 'a', ''] as never),
          listSchemas: () => Promise.resolve(null as never),
        },
      }),
    );
    expect(await metadata.listTables({})).toEqual([]);
    expect(await metadata.listColumns({ name: 't' })).toEqual([]);
    expect(await metadata.listDatabases()).toEqual(['a']);
    expect(await metadata.listSchemas()).toEqual([]);
  });

  it('lists no databases or schemas when the plugin has none', async () => {
    const metadata = await metadataOf(new FakePlugin());
    expect(await metadata.listDatabases()).toEqual([]);
    expect(await metadata.listSchemas('d')).toEqual([]);
  });

  it('passes the scope on and lists databases and schemas when the plugin has them', async () => {
    const scopes: unknown[] = [];
    const metadata = await metadataOf(
      new FakePlugin({
        metadata: {
          listDatabases: () => Promise.resolve(['d1', 'd2']),
          listSchemas: (database) => Promise.resolve([`${String(database)}.s`]),
          listTables: (scope) => {
            scopes.push(scope);
            return Promise.resolve([]);
          },
        },
      }),
    );
    expect(await metadata.listDatabases()).toEqual(['d1', 'd2']);
    expect(await metadata.listSchemas('d1')).toEqual(['d1.s']);
    await metadata.listTables({ database: 'd1', schema: 's' });
    expect(scopes).toEqual([{ database: 'd1', schema: 's' }]);
  });

  it('turns errors of the plugin into DbErrors', async () => {
    const fail = (): Promise<never> =>
      Promise.reject(Object.assign(new Error('x'), { code: 'permission-denied' }));
    const metadata = await metadataOf(
      new FakePlugin({
        metadata: { listTables: fail, listColumns: fail, listDatabases: fail, listSchemas: fail },
      }),
    );
    for (const call of [
      () => metadata.listTables({}),
      () => metadata.listColumns({ name: 't' }),
      () => metadata.listDatabases(),
      () => metadata.listSchemas(),
    ]) {
      await expect(call()).rejects.toMatchObject({ name: 'DbError', code: 'permission-denied' });
    }
  });

  it('has nothing to say about the rest, and refuses what needs it', async () => {
    const metadata = await metadataOf(new FakePlugin());
    expect(await metadata.listUniqueKeys({ name: 't' })).toEqual([]);
    expect(await metadata.listForeignKeys({ name: 't' })).toEqual([]);
    expect(await metadata.listObjects({}, 'function')).toEqual([]);
    expect(await metadata.listIndexes({ name: 't' })).toEqual([]);
    expect(await metadata.listTypeDumps({})).toEqual([]);
    for (const call of [
      () => metadata.describeTable({ name: 't' }),
      () => metadata.getDefinition({ kind: 'table', name: 't' }),
      () => metadata.getTableDump({ name: 't' }),
    ]) {
      await expect(call()).rejects.toMatchObject({ name: 'DbError', code: 'unsupported' });
    }
  });
});
