import { describe, expect, it, vi } from 'vitest';
import type { DriverId } from '../../../src/shared/connection';
import {
  LabelCache,
  readServerVersion,
  readSizeBytes,
  shortSize,
  shortVersion,
  sizeSql,
} from '../../../src/services/server-labels';
import { records, scriptedSession } from '../../helpers/scripted-session';

const DIALECT = {
  literal: (value: string) => `'${value.replaceAll("'", "''")}'`,
  quote: (name: string) => `"${name}"`,
};

describe('shortVersion', () => {
  it.each([
    ['15.19 (Debian 15.19-1.pgdg120+1)', '15.19'],
    ['8.0.35-0ubuntu0.22.04.1', '8.0.35'],
    ['10.11.6-MariaDB-1:10.11.6+maria~ubuntu2204', '10.11.6'],
    ['16.00.1000', '16.00.1000'],
    ['3.45.1', '3.45.1'],
    ['24.3', '24.3'],
    ['17.11', '17.11'],
    ['17.11 (Debian 17.11-1.pgdg120+1)', '17.11'],
    ['8.4.0', '8.4.0'],
    ['16.0.4125.3', '16.0.4125.3'],
    ['24.3.2.23', '24.3.2.23'],
    ['19.0.0.0.0', '19.0.0.0'],
    ['23.4.0.24.05', '23.4.0.24'],
    ['7.2.4', '7.2.4'],
    ['8.0.4', '8.0.4'],
    ['8.13.0', '8.13.0'],
    ['8.0.11-TiDB-v7.5.0', '8.0.11'],
    ['CockroachDB CCL v23.2.0 (x86_64-pc-linux-gnu)', '23.2.0'],
    ['PostgreSQL 15.19 on x86_64', '15.19'],
  ])('keeps the number of %s', (text, expected) => {
    expect(shortVersion(text)).toBe(expected);
  });

  it('has nothing to show without a number', () => {
    expect(shortVersion('unknown')).toBeUndefined();
    expect(shortVersion('')).toBeUndefined();
  });
});

describe('shortSize', () => {
  it.each([
    [0, '0B'],
    [812, '812B'],
    [2048, '2K'],
    [2_516_582, '2.4M'],
    [1_288_490_189, '1.2G'],
    [150 * 1024 * 1024, '150M'],
    [3 * 1024 ** 4, '3T'],
  ])('writes %d as %s', (bytes, text) => {
    expect(shortSize(bytes)).toBe(text);
  });
});

describe('sizeSql', () => {
  const ask = (driver: DriverId, database?: string, schema?: string) =>
    sizeSql(driver, { database, schema }, DIALECT);

  it('sums the relations of a PostgreSQL schema and measures the whole database without one', () => {
    expect(ask('postgres', 'app', 'public')).toContain("n.nspname = 'public'");
    expect(ask('postgres', 'app', 'public')).toContain('pg_total_relation_size');
    expect(ask('postgres', 'app')).toBe('SELECT pg_database_size(current_database()) AS size');
  });

  it('puts the schema in as a literal, quotes and all', () => {
    expect(ask('postgres', 'app', "o'brien")).toContain("n.nspname = 'o''brien'");
  });

  it('adds data and indexes of a MySQL database', () => {
    expect(ask('mysql', 'shop')).toContain("table_schema = 'shop'");
    expect(ask('mysql', 'shop')).toContain('data_length + index_length');
    expect(ask('mysql')).toBeUndefined();
  });

  it('counts used pages of a SQL Server database or schema, in that database', () => {
    const schema = ask('mssql', 'Shop', 'dbo');
    expect(schema).toContain('"Shop".sys.dm_db_partition_stats');
    expect(schema).toContain("s.name = 'dbo'");
    expect(ask('mssql', 'Shop')).not.toContain('sys.schemas');
    expect(ask('mssql')).toContain('FROM sys.dm_db_partition_stats');
  });

  it('adds the active parts of a ClickHouse database', () => {
    expect(ask('clickhouse', 'logs')).toContain("database = 'logs'");
    expect(ask('clickhouse')).toBeUndefined();
  });

  it.each(['sqlite', 'oracle', 'redis', 'mongodb', 'elasticsearch'] as const)(
    'has no cheap way for %s',
    (driver) => {
      expect(ask(driver, 'x', 'y')).toBeUndefined();
    },
  );
});

function managerWith(sql: (statement: string) => ReturnType<typeof records>, dialect = DIALECT) {
  const { session, executed } = scriptedSession(sql);
  const acquire = vi.fn((_owner: string, _target: unknown) => Promise.resolve(session));
  const manager = {
    acquire,
    driverOf: () =>
      Promise.resolve({
        id: 'x',
        capabilities: { databaseScopedSessions: false },
        dialect: {
          literal: (value: unknown) => dialect.literal(String(value)),
          quoteIdentifier: dialect.quote,
        },
      }),
    acquireRedis: vi.fn(),
    acquireMongo: vi.fn(),
    acquireElastic: vi.fn(),
  };
  return { manager: manager as never, acquire, executed };
}

describe('readServerVersion', () => {
  it('reads and shortens a SQL server version', async () => {
    const { manager, executed } = managerWith(() =>
      records([{ version: '15.19 (Debian 15.19-1.pgdg120+1)' }]),
    );
    expect(await readServerVersion(manager, 'c1', 'postgres')).toBe('15.19');
    expect(executed.join(' ')).toContain('server_version');
  });

  it('asks SQLite, MySQL, SQL Server, ClickHouse and Oracle their own way', async () => {
    const asked: string[] = [];
    for (const driver of ['sqlite', 'mysql', 'mssql', 'clickhouse', 'oracle'] as const) {
      const { manager, executed } = managerWith(() => records([{ version: '9.8.7' }]));
      expect(await readServerVersion(manager, 'c1', driver)).toBe('9.8.7');
      asked.push(executed[0] ?? '');
    }
    expect(asked[0]).toContain('sqlite_version()');
    expect(asked[1]).toContain('VERSION()');
    expect(asked[2]).toContain("SERVERPROPERTY('ProductVersion')");
    expect(asked[3]).toContain('version()');
    expect(asked[4]).toContain('product_component_version');
  });

  it('has nothing to show when the answer has no row or no number', async () => {
    expect(
      await readServerVersion(managerWith(() => records([])).manager, 'c1', 'mysql'),
    ).toBeUndefined();
    expect(
      await readServerVersion(
        managerWith(() => records([{ version: 'dev' }])).manager,
        'c1',
        'mysql',
      ),
    ).toBeUndefined();
  });

  it('takes MongoDB and Elasticsearch versions from the session, without a query', async () => {
    const { manager } = managerWith(() => records([]));
    const typed = manager as unknown as {
      acquireMongo: ReturnType<typeof vi.fn>;
      acquireElastic: ReturnType<typeof vi.fn>;
      acquireRedis: ReturnType<typeof vi.fn>;
    };
    typed.acquireMongo.mockResolvedValue({ server: { version: '8.2.12' } });
    typed.acquireElastic.mockResolvedValue({ server: { version: '8.19.6' } });
    typed.acquireRedis.mockResolvedValue({
      onMasters: () => Promise.resolve(['# Server\r\nredis_version:7.4.1\r\n']),
    });
    expect(await readServerVersion(manager, 'c1', 'mongodb')).toBe('8.2.12');
    expect(await readServerVersion(manager, 'c1', 'elasticsearch')).toBe('8.19.6');
    expect(await readServerVersion(manager, 'c1', 'redis')).toBe('7.4.1');
  });
});

describe('readSizeBytes', () => {
  it('reads the number of a size query', async () => {
    const { manager, executed } = managerWith(() =>
      records([{ size: { kind: 'bigint', text: '2516582' } }]),
    );
    expect(
      await readSizeBytes(manager, 'c1', 'postgres', { database: 'app', schema: 'public' }),
    ).toBe(2_516_582);
    expect(executed[0]).toContain("n.nspname = 'public'");
  });

  it('says nothing for drivers without a size query and for non-SQL ones', async () => {
    const { manager, acquire } = managerWith(() => records([{ size: 1 }]));
    expect(await readSizeBytes(manager, 'c1', 'sqlite', {})).toBeUndefined();
    expect(await readSizeBytes(manager, 'c1', 'redis', {})).toBeUndefined();
    expect(acquire).not.toHaveBeenCalled();
  });

  it('has no size when the row has none', async () => {
    const { manager } = managerWith(() => records([]));
    expect(await readSizeBytes(manager, 'c1', 'mysql', { database: 'shop' })).toBeUndefined();
  });
});

describe('LabelCache', () => {
  async function settle(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('reads once, tells when the answer lands and then serves it', async () => {
    const changed = vi.fn();
    const cache = new LabelCache<string>(changed);
    const read = vi.fn(() => Promise.resolve('15.19'));
    cache.ask('a', read);
    cache.ask('a', read);
    expect(cache.peek('a')).toBeUndefined();
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledWith('a');
    expect(cache.peek('a')).toBe('15.19');
    cache.ask('a', read);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('remembers a failure as nothing to show instead of asking again and again', async () => {
    const changed = vi.fn();
    const cache = new LabelCache<number>(changed);
    const read = vi.fn(() => Promise.reject<number>(new Error('no rights')));
    cache.ask('a', read);
    await settle();
    expect(cache.peek('a')).toBeUndefined();
    cache.ask('a', read);
    await settle();
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('tells what went wrong and reads again after the cache is cleared', async () => {
    const failed = vi.fn();
    const cache = new LabelCache<string>(() => undefined, failed);
    const error = new Error('no rights');
    let attempts = 0;
    const read = vi.fn(() =>
      ++attempts === 1 ? Promise.reject<string>(error) : Promise.resolve('17.11'),
    );
    cache.ask('a', read);
    await settle();
    expect(failed).toHaveBeenCalledWith('a', error);
    expect(cache.peek('a')).toBeUndefined();
    cache.clear();
    cache.ask('a', read);
    await settle();
    expect(read).toHaveBeenCalledTimes(2);
    expect(cache.peek('a')).toBe('17.11');
  });

  it('forgets by prefix so only one connection is read again', async () => {
    const cache = new LabelCache<number>(() => undefined);
    cache.ask('c1\u0000a', () => Promise.resolve(1));
    cache.ask('c2\u0000a', () => Promise.resolve(2));
    await settle();
    cache.clear('c1\u0000');
    expect(cache.peek('c1\u0000a')).toBeUndefined();
    expect(cache.peek('c2\u0000a')).toBe(2);
    cache.clear();
    expect(cache.peek('c2\u0000a')).toBeUndefined();
  });
});
