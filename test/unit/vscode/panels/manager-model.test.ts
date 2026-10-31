import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { TableInfo } from '../../../../src/core/model/objects';
import type { HistoryEntry } from '../../../../src/services/history';
import type { DumpRequest } from '../../../../src/services/sql-dump';
import {
  expandOutput,
  logEntryOf,
  ManagerModel,
  type ManagerModelDeps,
  type ManagerStart,
  sectionsFor,
} from '../../../../src/vscode/panels/manager-model';

const TABLES: TableInfo[] = [
  { name: 'orders', kind: 'table' },
  { name: 'users', kind: 'table' },
  { name: 'v_sales', kind: 'view' },
];

function entry(extra: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    id: 'h1',
    sql: 'SELECT 1',
    connectionId: 'c1',
    connectionName: 'Local',
    executedAt: 1000,
    durationMs: 5,
    ok: true,
    runs: 1,
    ...extra,
  };
}

function build(
  options: {
    start?: ManagerStart;
    history?: HistoryEntry[];
    driver?: 'postgres' | 'sqlite' | 'redis';
    databases?: string[];
    schemas?: string[];
    dump?: (request: DumpRequest) => Promise<unknown>;
    others?: { id: string; driver: string }[];
  } = {},
) {
  const history = options.history ?? [];
  const cleared: string[] = [];
  const dumps: DumpRequest[] = [];
  const configs = [
    {
      id: 'c1',
      name: 'Local',
      driver: options.driver ?? 'postgres',
      readOnly: true,
      production: true,
    },
    ...(options.others ?? []).map((other) => ({ ...other, name: other.id })),
  ];
  const session = {
    metadata: {
      listDatabases: vi.fn(() => Promise.resolve(options.databases ?? [])),
      listSchemas: vi.fn(() => Promise.resolve(options.schemas ?? [])),
      listTables: vi.fn(() => Promise.resolve(TABLES)),
    },
  };
  const deps = {
    connectionId: 'c1',
    start: options.start ?? {},
    store: {
      get: (id: string) => configs.find((config) => config.id === id),
      list: () => configs,
    },
    manager: {
      driverOf: () =>
        Promise.resolve({
          id: 'postgres',
          capabilities: {
            databases: (options.databases ?? []).length > 0,
            schemas: (options.schemas ?? []).length > 0,
            databaseScopedSessions: false,
          },
          dialect: {},
        }),
      connect: () => Promise.resolve(session),
      acquire: () => Promise.resolve(session),
    },
    cache: { wrap: (_id: string, reader: unknown) => reader },
    history: {
      list: vi.fn(() => history),
      clear: vi.fn((id?: string) => {
        cleared.push(id ?? '');
        return history.length;
      }),
    },
    dumper: {
      dump: async (request: DumpRequest) => {
        dumps.push(request);
        await options.dump?.(request);
        return {
          skipped: [{ kind: 'view', name: 'secret', reason: 'x' }],
          tables: 2,
          views: 1,
          objects: 0,
          rows: 9,
          durationMs: 40,
        };
      },
    },
    openSink: vi.fn(),
    now: () => new Date(2026, 9, 31, 14, 5),
  } as unknown as ManagerModelDeps;
  return { model: new ManagerModel(deps), session, cleared, dumps, history: deps.history };
}

describe('sectionsFor', () => {
  it('offers every section on a server and no process list on a SQLite file', () => {
    expect(sectionsFor('postgres')).toEqual(['log', 'dashboard', 'processes', 'dump', 'sync']);
    expect(sectionsFor('sqlite')).toEqual(['log', 'dashboard', 'dump', 'sync']);
  });

  it('offers nothing for the databases that are not SQL', () => {
    expect(sectionsFor('redis')).toEqual([]);
    expect(sectionsFor('mongodb')).toEqual([]);
  });
});

describe('logEntryOf', () => {
  it('keeps what the log shows and leaves out the connection', () => {
    expect(logEntryOf(entry({ rows: 3, database: 'shop', error: undefined, runs: 4 }))).toEqual({
      id: 'h1',
      at: 1000,
      sql: 'SELECT 1',
      ok: true,
      durationMs: 5,
      rows: 3,
      database: 'shop',
      runs: 4,
    });
  });

  it('carries the error and the rows affected', () => {
    const mapped = logEntryOf(entry({ ok: false, error: 'boom', affected: 2 }));
    expect(mapped).toMatchObject({ ok: false, error: 'boom', affected: 2 });
    expect(mapped).not.toHaveProperty('rows');
  });
});

describe('expandOutput', () => {
  const date = new Date(2026, 9, 31, 14, 5);

  it('fills the name and the time and puts a bare file name in the folder', () => {
    expect(expandOutput('{data_source}-{timestamp}.sql', 'shop', date, '/work')).toBe(
      '/work/shop-2026-10-31-1405.sql',
    );
  });

  it('keeps a path that already has a folder', () => {
    expect(expandOutput('/tmp/{data_source}.sql', 'shop', date, '/work')).toBe('/tmp/shop.sql');
    expect(expandOutput('C:\\dumps\\x-{timestamp}.sql', 'a', date, '/work')).toBe(
      'C:\\dumps\\x-2026-10-31-1405.sql',
    );
  });

  it('makes a name safe for every platform and falls back to "dump"', () => {
    expect(expandOutput('{data_source}.sql', 'a/b:c', date, undefined)).toBe('a-b-c.sql');
    expect(expandOutput('{data_source}.sql', '///', date, undefined)).toBe('dump.sql');
  });

  it('leaves a path without a folder alone when there is no folder to use', () => {
    expect(expandOutput('x.sql', 'a', date, undefined)).toBe('x.sql');
  });
});

describe('ManagerModel state', () => {
  it('names the connection and opens on the section asked for', () => {
    const { model } = build({ start: { section: 'dump', table: { name: 't', kind: 'view' } } });
    expect(model.state()).toMatchObject({
      connectionId: 'c1',
      connectionName: 'Local',
      driver: 'postgres',
      section: 'dump',
      table: { name: 't', kind: 'view' },
      readOnly: true,
      production: true,
    });
  });

  it('opens on the log when nothing is asked for, or the section is not offered', () => {
    expect(build().model.state().section).toBe('log');
    const sqlite = build({ driver: 'sqlite', start: { section: 'processes' } });
    expect(sqlite.model.state().section).toBe('log');
  });

  it('follows a new start', () => {
    const { model } = build();
    model.setStart({ section: 'sync', database: 'd', schema: 's' });
    expect(model.state()).toMatchObject({ section: 'sync', database: 'd', schema: 's' });
  });

  it('fails clearly when the connection is gone', () => {
    const { model } = build();
    const gone = new ManagerModel({
      connectionId: 'zzz',
      start: {},
      store: { get: () => undefined, list: () => [] },
    } as unknown as ManagerModelDeps);
    expect(() => gone.state()).toThrow(DbError);
    expect(model).toBeDefined();
  });
});

describe('ManagerModel tableView', () => {
  it('has none when the page was not opened from a table', () => {
    expect(build().model.tableView()).toBeUndefined();
  });

  it('describes the table, its scope and its kind for the table bar', () => {
    const { model } = build({
      start: { database: 'shop', schema: 'public', table: { name: 'v_sales', kind: 'view' } },
    });
    expect(model.tableView()).toEqual({
      target: { connectionId: 'c1', database: 'shop' },
      table: { name: 'v_sales', database: 'shop', schema: 'public' },
      kind: 'view',
    });
  });

  it('leaves the database out for a connection that has none', () => {
    const { model } = build({ start: { table: { name: 't', kind: 'table' } } });
    expect(model.tableView()).toEqual({
      target: { connectionId: 'c1' },
      table: { name: 't' },
      kind: 'table',
    });
  });
});

describe('ManagerModel log', () => {
  it('lists the statements of the connection oldest first', () => {
    const { model, history } = build({
      history: [entry({ id: 'new', executedAt: 3 }), entry({ id: 'old', executedAt: 1 })],
    });
    expect(model.log().map((line) => line.id)).toEqual(['old', 'new']);
    expect(history.list).toHaveBeenCalledWith({ connectionId: 'c1' });
  });

  it('clears the statements of this connection only', () => {
    const { model, cleared } = build({ history: [entry(), entry({ id: 'h2' })] });
    expect(model.clearLog()).toBe(2);
    expect(cleared).toEqual(['c1']);
  });
});

describe('ManagerModel dump', () => {
  it('offers the tables, ticking the one the page was opened from', async () => {
    const { model } = build({
      databases: ['shop', 'blog'],
      schemas: ['public'],
      start: { database: 'blog', table: { name: 'users', kind: 'table' } },
    });
    const options = await model.dumpOptions({}, '/work');
    expect(options).toMatchObject({
      databases: ['shop', 'blog'],
      database: 'blog',
      schemas: ['public'],
      schema: 'public',
      ticked: ['users'],
      output: '/work/users-2026-10-31-1405.sql',
    });
    expect(options.relations).toEqual([
      { name: 'orders', kind: 'table' },
      { name: 'users', kind: 'table' },
      { name: 'v_sales', kind: 'view' },
    ]);
  });

  it('ticks everything when the page was not opened from a table', async () => {
    const { model } = build();
    const options = await model.dumpOptions({}, undefined);
    expect(options.ticked).toEqual(['orders', 'users', 'v_sales']);
    expect(options.databases).toEqual([]);
    expect(options.database).toBeUndefined();
    expect(options.output).toBe('Local-2026-10-31-1405.sql');
  });

  it('prefers the database and schema the form picked', async () => {
    const { model } = build({ databases: ['a', 'b'], schemas: ['s1', 's2'] });
    const options = await model.dumpOptions({ database: 'b', schema: 's2' }, undefined);
    expect(options).toMatchObject({ database: 'b', schema: 's2' });
  });

  it('writes the ticked relations of the scope and reports', async () => {
    const { model, dumps } = build({ databases: ['shop'], schemas: ['public'] });
    const sink = { bytes: 123 } as never;
    const report = await model.dump(
      {
        database: 'shop',
        schema: 'public',
        relations: ['orders', 'nope'],
        wholeScope: false,
        content: 'all',
        dropFirst: true,
        output: '/work/x.sql',
      },
      sink,
      {},
    );
    expect(dumps).toHaveLength(1);
    expect(dumps[0]).toMatchObject({
      target: { connectionId: 'c1', database: 'shop' },
      scope: { database: 'shop', schema: 'public' },
      relations: [{ name: 'orders' }],
      wholeScope: false,
      content: 'all',
      dropFirst: true,
      source: 'Local / shop / public',
    });
    expect(report).toEqual({
      path: '/work/x.sql',
      bytes: 123,
      tables: 2,
      views: 1,
      objects: 0,
      rows: 9,
      durationMs: 40,
      skipped: ['secret'],
    });
  });

  it('never drops what a data-only dump inserts into', async () => {
    const { model, dumps } = build();
    await model.dump(
      {
        relations: ['users'],
        wholeScope: false,
        content: 'data',
        dropFirst: true,
        output: 'x.sql',
      },
      { bytes: 0 } as never,
      {},
    );
    expect(dumps[0]?.dropFirst).toBe(false);
    expect(dumps[0]?.target).toEqual({ connectionId: 'c1' });
  });

  it('refuses a dump of nothing, but dumps the routines of a scope alone', async () => {
    const { model, dumps } = build();
    const nothing = {
      relations: [],
      wholeScope: false,
      content: 'all' as const,
      dropFirst: false,
      output: 'x.sql',
    };
    await expect(model.dump(nothing, { bytes: 0 } as never, {})).rejects.toBeInstanceOf(DbError);
    await model.dump({ ...nothing, wholeScope: true }, { bytes: 0 } as never, {});
    expect(dumps).toHaveLength(1);
  });

  it('hands the signal and progress to the dumper', async () => {
    const signal = new AbortController().signal;
    const onProgress = vi.fn();
    const { model, dumps } = build();
    await model.dump(
      { relations: ['users'], wholeScope: false, content: 'all', dropFirst: false, output: 'x' },
      { bytes: 0 } as never,
      { signal, onProgress },
    );
    expect(dumps[0]?.signal).toBe(signal);
    expect(dumps[0]?.onProgress).toBe(onProgress);
  });
});

describe('ManagerModel structure sync', () => {
  it('offers the connections of the same kind of database', () => {
    const { model } = build({
      others: [
        { id: 'c2', driver: 'postgres' },
        { id: 'm1', driver: 'mysql' },
      ],
    });
    expect(model.syncConnections().map((connection) => connection.id)).toEqual(['c1', 'c2']);
  });

  it('lists the databases and schemas of a connection', async () => {
    const { model, session } = build({ databases: ['a', 'b'], schemas: ['s'] });
    expect(await model.syncScopes('c1', undefined)).toEqual({
      databases: ['a', 'b'],
      schemas: ['s'],
    });
    expect(session.metadata.listSchemas).toHaveBeenCalledWith('a');
    await model.syncScopes('c1', 'b');
    expect(session.metadata.listSchemas).toHaveBeenLastCalledWith('b');
  });

  it('gives no databases or schemas where the connection has none', async () => {
    const { model } = build();
    expect(await model.syncScopes('c1', undefined)).toEqual({ databases: [], schemas: [] });
  });

  it('refuses to compare a schema with itself', async () => {
    const { model } = build();
    const same = { connectionId: 'c1', database: 'd', schema: 's' };
    await expect(model.startSync(same, { ...same })).rejects.toBeInstanceOf(DbError);
    expect(model.compareModel).toBeUndefined();
  });
});
