import { describe, expect, it } from 'vitest';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';

describe('postgresDialect.quoteIdentifier', () => {
  it('wraps names in double quotes and escapes quotes by doubling', () => {
    expect(postgresDialect.quoteIdentifier('users')).toBe('"users"');
    expect(postgresDialect.quoteIdentifier('we"ird')).toBe('"we""ird"');
  });

  it('rejects empty names and NUL bytes', () => {
    expect(() => postgresDialect.quoteIdentifier('')).toThrow('empty');
    expect(() => postgresDialect.quoteIdentifier('a\u0000b')).toThrow('NUL');
  });
});

describe('postgresDialect.quoteTable', () => {
  it('qualifies with the schema when present', () => {
    expect(postgresDialect.quoteTable({ schema: 'public', name: 'orders' })).toBe(
      '"public"."orders"',
    );
    expect(postgresDialect.quoteTable({ name: 'orders' })).toBe('"orders"');
  });
});

describe('postgresDialect.literal', () => {
  it('renders primitives and escapes quotes without touching backslashes', () => {
    expect(postgresDialect.literal(null)).toBe('NULL');
    expect(postgresDialect.literal(true)).toBe('TRUE');
    expect(postgresDialect.literal("O'Brien")).toBe("'O''Brien'");
    expect(postgresDialect.literal('back\\slash')).toBe("'back\\slash'");
    expect(postgresDialect.literal(Number.NaN)).toBe('NULL');
  });

  it('keeps numeric text unquoted and casts binary previews to bytea', () => {
    expect(postgresDialect.literal({ kind: 'bigint', text: '9007199254740993' })).toBe(
      '9007199254740993',
    );
    expect(postgresDialect.literal({ kind: 'decimal', text: 'evil' })).toBe("'evil'");
    expect(postgresDialect.literal({ kind: 'binary', size: 4, preview: 'deadbeef' })).toBe(
      "'\\xdeadbeef'::bytea",
    );
  });
});

describe('postgresDialect.paginate', () => {
  it('appends LIMIT/OFFSET and validates the page', () => {
    expect(postgresDialect.paginate('SELECT * FROM t;', 100, 0)).toBe('SELECT * FROM t LIMIT 100');
    expect(postgresDialect.paginate('SELECT * FROM t', 50, 200)).toBe(
      'SELECT * FROM t LIMIT 50 OFFSET 200',
    );
    expect(() => postgresDialect.paginate('SELECT 1', -1, 0)).toThrow('Invalid page');
  });
});

describe('postgresDialect.keywords', () => {
  it('contains PostgreSQL-specific keywords in uppercase', () => {
    expect(postgresDialect.keywords).toContain('RETURNING');
    expect(postgresDialect.keywords).toContain('ILIKE');
    expect(postgresDialect.keywords.every((k) => k === k.toUpperCase())).toBe(true);
  });
});

describe('postgresDialect default handling', () => {
  it('says whether SET column = DEFAULT is available', () => {
    expect(postgresDialect.defaultKeyword).toBe(true);
  });

  it('inserts a row of defaults', () => {
    expect(postgresDialect.insertDefaultRow('"t"')).toBe('INSERT INTO "t" DEFAULT VALUES');
  });
});

describe('postgresDialect.likeText', () => {
  it('casts the column to text and escapes with !', () => {
    const q = postgresDialect.quoteIdentifier('c');
    expect(postgresDialect.likeText(q, "'%x%'")).toBe(`CAST(${q} AS TEXT) ILIKE '%x%' ESCAPE '!'`);
  });
});

describe('postgresDialect.estimateRowsSql', () => {
  it('reads reltuples through a quoted regclass name', () => {
    expect(postgresDialect.estimateRowsSql?.({ schema: 'public', name: 'orders' })).toBe(
      `SELECT reltuples::bigint FROM pg_class WHERE oid = '"public"."orders"'::regclass`,
    );
  });

  it('keeps a quote in a name from ending the literal', () => {
    expect(postgresDialect.estimateRowsSql?.({ name: "o'x" })).toContain(`'"o''x"'::regclass`);
  });
});

describe('postgresDialect.setTimeZone (V4.9)', () => {
  it('sets the session time zone with the name quoted', () => {
    expect(postgresDialect.setTimeZone?.('Europe/Berlin')).toBe("SET TIME ZONE 'Europe/Berlin'");
    expect(postgresDialect.setTimeZone?.("x'y")).toBe("SET TIME ZONE 'x''y'");
  });
});
