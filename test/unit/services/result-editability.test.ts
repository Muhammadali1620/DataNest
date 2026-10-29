import { describe, expect, it } from 'vitest';
import type { ColumnInfo } from '../../../src/core/model/objects';
import { syntaxOf } from '../../../src/core/sql/tokenizer';
import { analyzeEditability, tableRefOf } from '../../../src/services/result-editability';
import { FakeMetadata } from '../../helpers/fake-driver';
import { RecordingLogger } from '../../helpers/fakes';

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, dataType: 'int', nullable: false, primaryKey: false, ...overrides };
}

describe('tableRefOf', () => {
  it('reads database.table for databases and schema.table for schemas', () => {
    expect(tableRefOf(['t'], false)).toEqual({ name: 't' });
    expect(tableRefOf(['db', 't'], false)).toEqual({ database: 'db', name: 't' });
    expect(tableRefOf(['s', 't'], true)).toEqual({ schema: 's', name: 't' });
    expect(tableRefOf(['db', 's', 't'], true)).toEqual({ schema: 's', name: 't' });
    expect(tableRefOf([], true)).toBeUndefined();
  });
});

describe('analyzeEditability', () => {
  function setup(schemas = false) {
    const metadata = new FakeMetadata();
    metadata.tables = [
      { name: 'Users', kind: 'table' },
      { name: 'active_users', kind: 'view' },
    ];
    metadata.columns = [column('id', { primaryKey: true }), column('name', { nullable: true })];
    const logger = new RecordingLogger();
    const analyze = (sql: string, columns: string[]) =>
      analyzeEditability({ metadata, syntax: syntaxOf('mysql'), schemas, logger }, sql, columns);
    return { metadata, analyze };
  }

  it('keeps every result of a read-only connection read-only, without asking the server', async () => {
    const metadata = new FakeMetadata();
    const result = await analyzeEditability(
      {
        metadata,
        syntax: syntaxOf('mysql'),
        schemas: false,
        logger: new RecordingLogger(),
        readOnly: true,
      },
      'SELECT * FROM users',
      ['id'],
    );
    expect(result).toMatchObject({ editable: false, reason: 'connection-read-only' });
  });

  it('says a plain select of a keyed table is editable, with the server spelling of the name', async () => {
    const { analyze } = setup();
    expect(await analyze('SELECT * FROM users', ['id', 'name'])).toMatchObject({
      editable: true,
      table: { name: 'Users' },
      keyColumns: ['id'],
      keyIndexes: [0],
    });
  });

  it('carries the foreign keys of an editable table', async () => {
    const { analyze, metadata } = setup();
    metadata.foreignKeys = [
      { name: 'fk', columns: ['name'], target: { name: 'groups' }, targetColumns: ['id'] },
    ];
    expect(await analyze('SELECT * FROM users', ['id', 'name'])).toMatchObject({
      editable: true,
      foreignKeys: [{ name: 'fk', columns: ['name'], target: { name: 'groups' } }],
    });
  });

  it('adds nothing when the table has no foreign keys', async () => {
    const { analyze } = setup();
    expect(await analyze('SELECT * FROM users', ['id', 'name'])).not.toHaveProperty('foreignKeys');
  });

  it('stays editable when the foreign keys cannot be read', async () => {
    const { analyze, metadata } = setup();
    let first = true;
    const original = metadata.listForeignKeys.bind(metadata);
    metadata.listForeignKeys = (table) => {
      if (first) {
        first = false;
        return Promise.reject(new Error('no permission'));
      }
      return original(table);
    };
    expect(await analyze('SELECT * FROM users', ['id', 'name'])).toMatchObject({ editable: true });
  });

  it('does not look for foreign keys of a result that is not editable', async () => {
    const { analyze, metadata } = setup();
    await analyze('SELECT * FROM active_users', ['id', 'name']);
    expect(metadata.calls.some((call) => call.startsWith('listForeignKeys'))).toBe(false);
  });

  it('does not ask for unique keys when there is a primary key', async () => {
    const { analyze, metadata } = setup();
    await analyze('SELECT * FROM Users', ['id', 'name']);
    expect(metadata.calls.some((call) => call.startsWith('listUniqueKeys'))).toBe(false);
  });

  it('asks for unique keys when there is no primary key and uses them', async () => {
    const { analyze, metadata } = setup();
    metadata.columns = [column('code'), column('name', { nullable: true })];
    metadata.uniqueKeys = [['code']];
    expect(await analyze('SELECT * FROM Users', ['code', 'name'])).toMatchObject({
      editable: true,
      keyColumns: ['code'],
    });
  });

  it('is read-only for a view', async () => {
    const { analyze } = setup();
    expect(await analyze('SELECT * FROM active_users', ['id', 'name'])).toEqual({
      editable: false,
      reason: 'view',
    });
  });

  it('is read-only for a table the server does not list or that has no columns', async () => {
    const { analyze, metadata } = setup();
    expect(await analyze('SELECT * FROM ghosts', ['id'])).toEqual({
      editable: false,
      reason: 'table-not-found',
    });
    metadata.columns = [];
    expect(await analyze('SELECT * FROM Users', ['id'])).toEqual({
      editable: false,
      reason: 'table-not-found',
    });
  });

  it('passes the statement refusal on without touching the server', async () => {
    const { analyze, metadata } = setup();
    expect(await analyze('SELECT * FROM Users a JOIN Users b ON 1', ['id'])).toEqual({
      editable: false,
      reason: 'multiple-tables',
    });
    expect(metadata.calls).toEqual([]);
  });

  it('is read-only, not an error, when the server cannot be asked', async () => {
    const { analyze, metadata } = setup();
    metadata.error = new Error('permission denied');
    expect(await analyze('SELECT * FROM Users', ['id', 'name'])).toEqual({
      editable: false,
      reason: 'failed',
    });
  });

  it('scopes the lookup by the qualifier in the statement', async () => {
    const { analyze, metadata } = setup(true);
    metadata.schemas = ['public', 'app'];
    await analyze('SELECT * FROM app.Users', ['id', 'name']);
    expect(metadata.calls.slice(0, 2)).toEqual(['listSchemas:', 'listTables:/app']);
  });

  it('finds the schema regardless of case, as Oracle reads an unquoted name (V6.4)', async () => {
    const { analyze, metadata } = setup(true);
    metadata.schemas = ['DATANEST', 'SYSTEM'];
    expect(await analyze('SELECT * FROM datanest.users', ['id', 'name'])).toMatchObject({
      editable: true,
      table: { schema: 'DATANEST', name: 'Users' },
    });
    expect(metadata.calls[1]).toBe('listTables:/DATANEST');
  });

  it('prefers the exact schema and keeps an unknown one as written', async () => {
    const { analyze, metadata } = setup(true);
    metadata.schemas = ['App', 'app'];
    await analyze('SELECT * FROM app.Users', ['id', 'name']);
    expect(metadata.calls[1]).toBe('listTables:/app');
    metadata.schemas = ['other'];
    await analyze('SELECT * FROM nowhere.Users', ['id', 'name']);
    expect(metadata.calls).toContain('listTables:/nowhere');
  });

  it('edits an Oracle DATE as a moment, and the same type elsewhere as a day (V6.4)', async () => {
    const metadata = new FakeMetadata();
    metadata.tables = [{ name: 'T', kind: 'table' }];
    metadata.columns = [
      column('ID', { primaryKey: true }),
      column('BORN', { dataType: 'DATE', nullable: true }),
    ];
    const kindOf = async (driver: 'oracle' | 'mysql' | undefined) => {
      const result = await analyzeEditability(
        {
          metadata,
          syntax: syntaxOf(driver),
          schemas: false,
          logger: new RecordingLogger(),
          ...(driver === undefined ? {} : { driver }),
        },
        'SELECT * FROM T',
        ['ID', 'BORN'],
      );
      return result.editable ? result.columns[1]?.kind : undefined;
    };
    expect(await kindOf('oracle')).toBe('datetime');
    expect(await kindOf('mysql')).toBe('date');
    expect(await kindOf(undefined)).toBe('date');
  });
});
