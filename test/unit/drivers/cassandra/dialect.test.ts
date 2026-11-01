import { describe, expect, it } from 'vitest';
import {
  cassandraDialect,
  comparisonLiteral,
  literal,
  paginate,
  quoteIdentifier,
  quoteString,
  quoteTable,
  skipOf,
} from '../../../../src/drivers/cassandra/dialect';

describe('quoting', () => {
  it('quotes names with double quotes and doubles the ones inside', () => {
    expect(quoteIdentifier('users')).toBe('"users"');
    expect(quoteIdentifier('a"b')).toBe('"a""b"');
    expect(() => quoteIdentifier('')).toThrow();
    expect(() => quoteIdentifier('a\u0000b')).toThrow();
  });

  it('writes a table as keyspace.table, from the database or the schema of the scope', () => {
    expect(quoteTable({ database: 'shop', name: 'users' })).toBe('"shop"."users"');
    expect(quoteTable({ schema: 'shop', name: 'users' })).toBe('"shop"."users"');
    expect(quoteTable({ name: 'users' })).toBe('"users"');
  });

  it('quotes strings with doubled single quotes and no backslash magic', () => {
    expect(quoteString("it's")).toBe("'it''s'");
    expect(quoteString('a\\b')).toBe("'a\\b'");
  });
});

describe('literal', () => {
  it('writes nulls, booleans and numbers', () => {
    expect(literal(null)).toBe('null');
    expect(literal(true)).toBe('true');
    expect(literal(false)).toBe('false');
    expect(literal(12)).toBe('12');
    expect(literal(-1.5)).toBe('-1.5');
    expect(literal(Number.NaN)).toBe('NaN');
    expect(literal(Number.POSITIVE_INFINITY)).toBe('Infinity');
    expect(literal(Number.NEGATIVE_INFINITY)).toBe('-Infinity');
  });

  it('writes text with doubled quotes', () => {
    expect(literal("O'Hara")).toBe("'O''Hara'");
  });

  it('writes exact numbers bare, and anything that is not a number as text', () => {
    expect(literal({ kind: 'bigint', text: '9007199254740993' })).toBe('9007199254740993');
    expect(literal({ kind: 'bigint', text: '1; DROP' })).toBe("'1; DROP'");
    expect(literal({ kind: 'decimal', text: '1.10' })).toBe('1.10');
    expect(literal({ kind: 'decimal', text: '1e5' })).toBe('1e5');
    expect(literal({ kind: 'decimal', text: "x'" })).toBe("'x'''");
  });

  it('writes dates and json as text, and bytes as 0x… when the preview is the whole value', () => {
    expect(literal({ kind: 'datetime', text: '2024-01-31T10:00:00.000Z' })).toBe(
      "'2024-01-31T10:00:00.000Z'",
    );
    expect(literal({ kind: 'json', text: '{"a":1}' })).toBe(`'{"a":1}'`);
    expect(literal({ kind: 'binary', size: 2, preview: 'cafe' })).toBe('0xcafe');
    expect(literal({ kind: 'binary', size: 3000, preview: 'cafe' })).toBe("'cafe'");
  });
});

describe('paginate', () => {
  it('limits the first page and leaves the marker for later ones', () => {
    expect(paginate('SELECT * FROM t;', 50, 0)).toBe('SELECT * FROM t LIMIT 50');
    expect(paginate('SELECT * FROM t', 50, 100)).toBe(
      'SELECT * FROM t LIMIT 150 /* datanest:skip=100 */',
    );
  });

  it('refuses a page that is no page', () => {
    expect(() => paginate('SELECT 1', -1, 0)).toThrow();
    expect(() => paginate('SELECT 1', 10, -5)).toThrow();
    expect(() => paginate('SELECT 1', 1.5, 0)).toThrow();
  });

  it('is read back by skipOf', () => {
    expect(skipOf(paginate('SELECT * FROM t', 50, 100))).toEqual({
      sql: 'SELECT * FROM t LIMIT 150',
      skip: 100,
    });
    expect(skipOf('SELECT 1')).toEqual({ sql: 'SELECT 1', skip: 0 });
    expect(skipOf('SELECT 1 /* skip me */')).toEqual({ sql: 'SELECT 1 /* skip me */', skip: 0 });
  });
});

describe('the dialect', () => {
  it('matches filters with LIKE, which needs an index on the server', () => {
    expect(cassandraDialect.likeText('"name"', "'%a%'")).toBe(`"name" LIKE '%a%'`);
  });

  it('has no default row and no dump', () => {
    expect(() => cassandraDialect.insertDefaultRow('"t"')).toThrow(/key/u);
    expect(() => cassandraDialect.dump.insert('"t"', [], [], false)).toThrow(/dump/u);
    expect(() => cassandraDialect.dump.insertSelect('"t"', [], 'SELECT 1', false)).toThrow(/dump/u);
    expect(() => cassandraDialect.dump.dropObject({ kind: 'function', name: 'f' })).toThrow();
    expect(cassandraDialect.dump.dropRelations([], 'table')).toEqual([]);
  });

  it('creates and drops keyspaces, tables and views, and truncates', () => {
    const { ddl } = cassandraDialect;
    expect(ddl.createDatabase?.('shop')).toBe(
      `CREATE KEYSPACE "shop" WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
    );
    expect(ddl.dropDatabase?.('shop')).toBe('DROP KEYSPACE "shop"');
    const table = { database: 'shop', name: 'users' };
    expect(ddl.dropRelation(table, 'table')).toBe('DROP TABLE "shop"."users"');
    expect(ddl.dropRelation(table, 'materialized-view')).toBe(
      'DROP MATERIALIZED VIEW "shop"."users"',
    );
    expect(ddl.truncateTable(table)).toBe('TRUNCATE "shop"."users"');
  });

  it('says what cannot be done', () => {
    const { ddl } = cassandraDialect;
    const table = { database: 'shop', name: 'users' };
    expect(() => ddl.createTable(table, {} as never)).toThrow(/CQL/u);
    expect(() => ddl.alterTable(table, {} as never, {} as never, {} as never)).toThrow(/CQL/u);
    expect(() => ddl.renameRelation(table, 'table', 'x')).toThrow(/rename/u);
    expect(() => ddl.dropObject({ kind: 'function', name: 'f' })).toThrow(/CQL/u);
    expect(() => ddl.replaceObject({ kind: 'function', name: 'f' }, [], [])).toThrow(/CQL/u);
    expect(ddl.designer.types).toEqual([]);
  });

  it('keeps the transaction words harmless', () => {
    expect(cassandraDialect.transaction.savepoint('x')).toContain('SELECT');
  });
});

describe('comparisonLiteral', () => {
  it('writes a number bare for a numeric column, and as text for a text one', () => {
    for (const type of ['int', 'bigint', 'smallint', 'tinyint', 'varint', 'double', 'decimal']) {
      expect(comparisonLiteral('7', type), type).toBe('7');
    }
    expect(comparisonLiteral(' -1.5e3 ', 'double')).toBe('-1.5e3');
    expect(comparisonLiteral('7', 'text')).toBe("'7'");
    expect(comparisonLiteral("it's", 'text')).toBe("'it''s'");
  });

  it('keeps what does not fit the type a string, for the server to judge', () => {
    expect(comparisonLiteral('seven', 'int')).toBe("'seven'");
    expect(comparisonLiteral('1; DROP', 'int')).toBe("'1; DROP'");
    expect(comparisonLiteral('maybe', 'boolean')).toBe("'maybe'");
    expect(comparisonLiteral('7', undefined)).toBe("'7'");
  });

  it('writes booleans, uuids and blobs bare', () => {
    expect(comparisonLiteral('TRUE', 'boolean')).toBe('true');
    const id = '123e4567-e89b-12d3-a456-426614174000';
    expect(comparisonLiteral(id, 'uuid')).toBe(id);
    expect(comparisonLiteral(id, 'timeuuid')).toBe(id);
    expect(comparisonLiteral('not-a-uuid', 'uuid')).toBe("'not-a-uuid'");
    expect(comparisonLiteral('0xCAFE', 'blob')).toBe('0xCAFE');
    expect(comparisonLiteral('cafe', 'blob')).toBe("'cafe'");
  });

  it('writes dates and addresses as text', () => {
    expect(comparisonLiteral('2024-01-31', 'date')).toBe("'2024-01-31'");
    expect(comparisonLiteral('10.0.0.1', 'inet')).toBe("'10.0.0.1'");
  });
});
