import { describe, expect, it } from 'vitest';
import { CassandraMetadata, type CqlReader } from '../../../../src/drivers/cassandra/metadata';
import type { CellValue } from '../../../../src/shared/cell-value';

interface Call {
  readonly cql: string;
  readonly parameters: readonly unknown[];
}

/** A reader that answers by the start of the question and remembers what it was asked. */
function reader(answers: Record<string, CellValue[][]>): CqlReader & { readonly calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    queryRows(cql, parameters = []) {
      calls.push({ cql, parameters });
      const key = Object.keys(answers).find((start) => cql.includes(start));
      return Promise.resolve(key === undefined ? [] : (answers[key] ?? []));
    },
  };
}

const json = (value: unknown): CellValue => ({ kind: 'json', text: JSON.stringify(value) });

const COLUMNS: CellValue[][] = [
  ['body', 'text', 'regular', -1, 'none'],
  ['sent', 'timestamp', 'clustering', 0, 'desc'],
  ['room', 'text', 'partition_key', 0, 'none'],
  ['tenant', 'int', 'partition_key', 1, 'none'],
  ['seen', 'boolean', 'static', -1, 'none'],
  ['author', 'text', 'regular', -1, 'none'],
];

describe('keyspaces and tables', () => {
  it('lists keyspaces by name', async () => {
    const metadata = new CassandraMetadata(
      reader({ 'system_schema.keyspaces': [['shop'], ['Alpha'], ['system'], ['']] }),
    );
    expect(await metadata.listDatabases()).toEqual(['Alpha', 'shop', 'system']);
    expect(await metadata.listSchemas()).toEqual([]);
  });

  it('lists tables and materialized views of a keyspace, by name', async () => {
    const asked = reader({
      'system_schema.tables': [['users'], ['events']],
      'system_schema.views': [['users_by_email']],
    });
    const metadata = new CassandraMetadata(asked);
    expect(await metadata.listTables({ database: 'shop' })).toEqual([
      { name: 'events', kind: 'table' },
      { name: 'users', kind: 'table' },
      { name: 'users_by_email', kind: 'view', materialized: true },
    ]);
    expect(asked.calls.map((call) => call.parameters)).toEqual([['shop'], ['shop']]);
  });

  it('asks for a keyspace when there is none', async () => {
    const metadata = new CassandraMetadata(reader({}));
    await expect(metadata.listTables({})).rejects.toMatchObject({ code: 'unsupported' });
    await expect(metadata.listTables({ database: '' })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('takes the keyspace from the schema of a scope too', async () => {
    const asked = reader({});
    await new CassandraMetadata(asked).listTables({ schema: 'shop' });
    expect(asked.calls[0]?.parameters).toEqual(['shop']);
  });
});

describe('columns', () => {
  it('puts the partition key first, then clustering, then the rest by name, and marks the key', async () => {
    const asked = reader({ 'system_schema.columns': COLUMNS });
    const columns = await new CassandraMetadata(asked).listColumns({
      database: 'shop',
      name: 'messages',
    });
    expect(columns.map((column) => column.name)).toEqual([
      'room',
      'tenant',
      'sent',
      'author',
      'body',
      'seen',
    ]);
    expect(columns.map((column) => column.primaryKey)).toEqual([
      true,
      true,
      true,
      false,
      false,
      false,
    ]);
    expect(columns.map((column) => column.nullable)).toEqual([
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(columns[2]?.dataType).toBe('timestamp');
    expect(asked.calls[0]?.parameters).toEqual(['shop', 'messages']);
  });

  it('knows no unique keys, no foreign keys and no designer', async () => {
    const metadata = new CassandraMetadata(reader({}));
    expect(await metadata.listUniqueKeys()).toEqual([]);
    expect(await metadata.listForeignKeys()).toEqual([]);
    await expect(metadata.describeTable()).rejects.toMatchObject({ code: 'unsupported' });
    await expect(metadata.getTableDump()).rejects.toMatchObject({ code: 'unsupported' });
    expect(await metadata.listTypeDumps()).toEqual([]);
  });
});

describe('indexes', () => {
  it('lists the primary key first, then the secondary indexes by name', async () => {
    const metadata = new CassandraMetadata(
      reader({
        'system_schema.columns': COLUMNS,
        'system_schema.indexes': [
          ['by_body', 'COMPOSITES', json({ target: 'body' })],
          ['by_author', 'CUSTOM', json({ target: 'author', class_name: 'sai' })],
          ['broken', 'COMPOSITES', json({})],
        ],
      }),
    );
    expect(await metadata.listIndexes({ database: 'shop', name: 'messages' })).toEqual([
      { name: 'PRIMARY KEY', columns: ['room', 'tenant', 'sent'], unique: true, primary: true },
      { name: 'broken', columns: [], unique: false, primary: false, method: 'COMPOSITES' },
      { name: 'by_author', columns: ['author'], unique: false, primary: false, method: 'CUSTOM' },
      { name: 'by_body', columns: ['body'], unique: false, primary: false, method: 'COMPOSITES' },
    ]);
  });

  it('lists no primary key for a table without columns, and survives odd option cells', async () => {
    const metadata = new CassandraMetadata(
      reader({
        'system_schema.indexes': [
          ['a', 'KEYS', 'not json'],
          ['b', 'KEYS', { kind: 'json', text: '[1]' }],
          ['c', 'KEYS', null],
        ],
      }),
    );
    const indexes = await metadata.listIndexes({ database: 'shop', name: 't' });
    expect(indexes.map((index) => index.name)).toEqual(['a', 'b', 'c']);
    expect(indexes.every((index) => index.columns.length === 0)).toBe(true);
  });
});

describe('definitions', () => {
  it('writes CREATE TABLE with the key, the clustering order, statics and the indexes', async () => {
    const metadata = new CassandraMetadata(
      reader({
        'system_schema.columns': COLUMNS,
        'system_schema.indexes': [
          ['by_body', 'COMPOSITES', json({ target: 'body' })],
          ['by_author', 'CUSTOM', json({ target: 'author', class_name: 'org.x.Sai' })],
        ],
      }),
    );
    const statements = await metadata.getDefinition({
      kind: 'table',
      database: 'shop',
      name: 'messages',
    });
    expect(statements[0]).toBe(
      'CREATE TABLE "shop"."messages" ("room" text, "tenant" int, "sent" timestamp, "author" text, "body" text, "seen" boolean STATIC, ' +
        'PRIMARY KEY (("room", "tenant"), "sent")) WITH CLUSTERING ORDER BY ("sent" DESC)',
    );
    expect(statements.slice(1)).toEqual([
      'CREATE INDEX "by_body" ON "shop"."messages" (body)',
      `CREATE CUSTOM INDEX "by_author" ON "shop"."messages" (author) USING 'org.x.Sai'`,
    ]);
  });

  it('writes a table without clustering columns without an order', async () => {
    const metadata = new CassandraMetadata(
      reader({
        'system_schema.columns': [
          ['id', 'uuid', 'partition_key', 0, 'none'],
          ['v', 'text', 'regular', -1, 'none'],
        ],
      }),
    );
    expect(await metadata.getDefinition({ kind: 'table', database: 'ks', name: 't' })).toEqual([
      'CREATE TABLE "ks"."t" ("id" uuid, "v" text, PRIMARY KEY (("id")))',
    ]);
  });

  it('writes a materialized view with its base table and condition', async () => {
    const metadata = new CassandraMetadata(
      reader({
        'system_schema.columns': [
          ['email', 'text', 'partition_key', 0, 'none'],
          ['id', 'uuid', 'clustering', 0, 'asc'],
        ],
        'system_schema.views': [['users', 'email IS NOT NULL AND id IS NOT NULL']],
      }),
    );
    expect(
      await metadata.getDefinition({ kind: 'view', database: 'ks', name: 'users_by_email' }),
    ).toEqual([
      'CREATE MATERIALIZED VIEW "ks"."users_by_email" AS SELECT "email", "id" FROM "ks"."users" ' +
        'WHERE email IS NOT NULL AND id IS NOT NULL PRIMARY KEY (("email"), "id") WITH CLUSTERING ORDER BY ("id" ASC)',
    ]);
  });

  it('says a missing table is missing', async () => {
    const metadata = new CassandraMetadata(reader({}));
    await expect(
      metadata.getDefinition({ kind: 'table', database: 'ks', name: 'nope' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('refuses kinds Cassandra does not have', async () => {
    const metadata = new CassandraMetadata(reader({}));
    await expect(
      metadata.getDefinition({ kind: 'trigger', database: 'ks', name: 'x' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('functions', () => {
  it('lists functions with their argument types, and nothing of other kinds', async () => {
    const metadata = new CassandraMetadata(
      reader({
        'system_schema.functions': [
          ['plus', json(['int', 'int'])],
          ['alone', json([])],
        ],
      }),
    );
    expect(await metadata.listObjects({ database: 'ks' }, 'function')).toEqual([
      { name: 'alone', kind: 'function' },
      { name: 'plus', kind: 'function', signature: 'int, int' },
    ]);
    expect(await metadata.listObjects({ database: 'ks' }, 'procedure')).toEqual([]);
  });

  it('writes CREATE FUNCTION from the stored body', async () => {
    const metadata = new CassandraMetadata(
      reader({
        'system_schema.functions': [
          [json(['a', 'b']), json(['int', 'int']), 'int', 'java', 'return a + b;'],
        ],
      }),
    );
    expect(
      await metadata.getDefinition({ kind: 'function', database: 'ks', name: 'plus' }),
    ).toEqual([
      'CREATE OR REPLACE FUNCTION "ks"."plus"("a" int, "b" int) CALLED ON NULL INPUT RETURNS int LANGUAGE java AS $$return a + b;$$',
    ]);
  });

  it('says a missing function is missing', async () => {
    const metadata = new CassandraMetadata(reader({}));
    await expect(
      metadata.getDefinition({ kind: 'function', database: 'ks', name: 'nope' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
