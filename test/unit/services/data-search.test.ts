import { describe, expect, it } from 'vitest';
import { clickhouseDialect } from '../../../src/drivers/clickhouse/dialect';
import { mssqlDialect } from '../../../src/drivers/mssql/dialect';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { oracleDialect } from '../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import {
  containsCondition,
  likePattern,
  MAX_SEARCH_TEXT,
  searchableColumn,
  searchData,
} from '../../../src/services/data-search';
import type { ColumnInfo } from '../../../src/core/model/objects';
import { FakeSession } from '../../helpers/fake-driver';

describe('likePattern', () => {
  it('wraps the text in % and escapes what LIKE would read as a wildcard', () => {
    expect(likePattern('50%_off!', 'postgres')).toBe('%50!%!_off!!%');
    expect(likePattern('plain', 'mysql')).toBe('%plain%');
  });

  it('escapes [ only on SQL Server, where it opens a set', () => {
    expect(likePattern('[x]', 'mssql')).toBe('%![x]%');
    expect(likePattern('[x]', 'oracle')).toBe('%[x]%');
  });
});

describe('searchableColumn', () => {
  it('searches text kinds and enums', () => {
    for (const type of [
      'varchar(50)',
      'text',
      'nvarchar(max)',
      'char(2)',
      'clob',
      "enum('a','b')",
      'String',
      'citext',
    ]) {
      expect(searchableColumn(type, 'mysql'), type).toBe(true);
    }
  });

  it('leaves out numbers, dates, binary, JSON, spatial, XML, uuid and arrays', () => {
    for (const type of [
      'int',
      'decimal(10,2)',
      'date',
      'timestamp',
      'blob',
      'bytea',
      'json',
      'jsonb',
      'geometry',
      'point',
      'xml',
      'uuid',
      'text[]',
      'boolean',
    ]) {
      expect(searchableColumn(type, 'postgres'), type).toBe(false);
    }
  });
});

describe('containsCondition', () => {
  it.each([
    ['mysql', mysqlDialect, "`note` LIKE '%a''b%' ESCAPE '!'"],
    ['sqlite', sqliteDialect, `"note" LIKE '%a''b%' ESCAPE '!'`],
    ['mssql', mssqlDialect, "[note] LIKE N'%a''b%' ESCAPE '!'"],
    ['postgres', postgresDialect, `"note"::text ILIKE '%a''b%' ESCAPE '!'`],
    ['oracle', oracleDialect, `UPPER("note") LIKE UPPER('%a''b%') ESCAPE '!'`],
    ['clickhouse', clickhouseDialect, "positionCaseInsensitiveUTF8(toString(`note`), 'a\\'b') > 0"],
  ] as const)('%s ignores case and quotes the text as a literal', (driver, dialect, expected) => {
    expect(containsCondition('note', "a'b", dialect, driver)).toBe(expected);
  });
});

describe('searchData', () => {
  function session() {
    const fake = new FakeSession({ id: 'c', name: 'c', driver: 'postgres' });
    fake.metadata.tables = [
      { name: 'customers', kind: 'table' },
      { name: 'orders', kind: 'table' },
      { name: 'numbers', kind: 'table' },
      { name: 'order_view', kind: 'view' },
    ];
    const columns = {
      customers: [
        { name: 'id', dataType: 'integer', nullable: false, primaryKey: true },
        { name: 'name', dataType: 'text', nullable: true, primaryKey: false },
        { name: 'email', dataType: 'varchar(100)', nullable: true, primaryKey: false },
      ],
      orders: [{ name: 'note', dataType: 'text', nullable: true, primaryKey: false }],
      numbers: [{ name: 'n', dataType: 'integer', nullable: false, primaryKey: false }],
    } as const;
    const known = new Map<string, readonly ColumnInfo[]>(Object.entries(columns));
    fake.metadata.listColumns = (table) => Promise.resolve([...(known.get(table.name) ?? [])]);
    fake.rowsFor = (sql) =>
      sql.includes('"customers"') ? [[3, 1, 2]] : sql.includes('"orders"') ? [[0, 0]] : [];
    return fake;
  }

  it('counts the rows with the text, per column, in every table with text columns', async () => {
    const fake = session();
    const progress: string[] = [];
    const report = await searchData({
      session: fake,
      dialect: postgresDialect,
      driver: 'postgres',
      scope: { schema: 'public' },
      text: 'ann',
      onProgress: (done, total, table) => progress.push(`${done}/${total} ${table}`),
    });
    expect(report).toMatchObject({ tables: 3, failures: [], cancelled: false });
    expect(report.hits).toEqual([
      {
        table: { schema: 'public', name: 'customers' },
        rows: 3,
        columns: [
          { name: 'name', rows: 1 },
          { name: 'email', rows: 2 },
        ],
        where: `"name"::text ILIKE '%ann%' ESCAPE '!' OR "email"::text ILIKE '%ann%' ESCAPE '!'`,
      },
    ]);
    // Views are not searched; a table without text columns asks the server nothing.
    expect(
      fake.executed.some((sql) => sql.includes('order_view') || sql.includes('"numbers"')),
    ).toBe(false);
    expect(fake.executed[0]).toMatch(/^SELECT COUNT\(\*\), SUM\(CASE WHEN "name"/u);
    expect(progress).toEqual(['0/3 customers', '1/3 orders', '2/3 numbers']);
  });

  it('goes on past a table the server refuses, and reports it', async () => {
    const fake = session();
    fake.failExecuteWhen = (sql) => sql.includes('"customers"');
    const report = await searchData({
      session: fake,
      dialect: postgresDialect,
      driver: 'postgres',
      scope: {},
      text: 'x',
    });
    expect(report.hits).toEqual([]);
    expect(report.failures).toEqual([
      { table: 'customers', error: expect.stringContaining('Not allowed') as unknown },
    ]);
  });

  it('stops when cancelled and says how far it got', async () => {
    const fake = session();
    const abort = new AbortController();
    const report = await searchData({
      session: fake,
      dialect: postgresDialect,
      driver: 'postgres',
      scope: {},
      text: 'x',
      signal: abort.signal,
      onProgress: (done) => {
        if (done === 1) {
          abort.abort();
        }
      },
    });
    // The table being read when the cancel came is finished; the next one is not begun.
    expect(report).toMatchObject({ cancelled: true, tables: 2 });
    const stopped = await searchData({
      session: fake,
      dialect: postgresDialect,
      driver: 'postgres',
      scope: {},
      text: 'x',
      signal: abort.signal,
    });
    expect(stopped).toMatchObject({ cancelled: true, tables: 0, hits: [] });
  });

  it('cuts a very long text', async () => {
    const fake = session();
    await searchData({
      session: fake,
      dialect: postgresDialect,
      driver: 'postgres',
      scope: {},
      text: 'y'.repeat(MAX_SEARCH_TEXT + 100),
    });
    expect(fake.executed[0]).toContain(`%${'y'.repeat(MAX_SEARCH_TEXT)}%'`);
    expect(fake.executed[0]).not.toContain('y'.repeat(MAX_SEARCH_TEXT + 1));
  });
});
