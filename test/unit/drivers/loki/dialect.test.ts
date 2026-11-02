import { describe, expect, it } from 'vitest';
import {
  lokiDialect,
  literal,
  paginate,
  quoteIdentifier,
} from '../../../../src/drivers/loki/dialect';

describe('Loki dialect', () => {
  it('quotes a name in backticks and doubles a backtick inside', () => {
    expect(quoteIdentifier('app')).toBe('`app`');
    expect(quoteIdentifier('a`b')).toBe('`a``b`');
    expect(lokiDialect.quoteTable({ name: 'app', database: 'ignored' })).toBe('`app`');
  });

  it('writes literals', () => {
    expect(literal(null)).toBe('NULL');
    expect(literal(true)).toBe('true');
    expect(literal(false)).toBe('false');
    expect(literal(1.5)).toBe('1.5');
    expect(literal(Number.POSITIVE_INFINITY)).toBe("'Infinity'");
    expect(literal("it's")).toBe("'it\\'s'");
    expect(literal('a\\b')).toBe("'a\\\\b'");
    expect(literal({ kind: 'bigint', text: '1730000000000000001' })).toBe('1730000000000000001');
    expect(literal({ kind: 'bigint', text: 'x' })).toBe("'x'");
    expect(literal({ kind: 'decimal', text: '1.50' })).toBe('1.50');
    expect(literal({ kind: 'datetime', text: '2026-11-02T00:00:00Z' })).toBe(
      "'2026-11-02T00:00:00Z'",
    );
    expect(literal({ kind: 'json', text: '{"a":1}' })).toBe('\'{"a":1}\'');
    expect(literal({ kind: 'binary', size: 2, preview: 'abcd' })).toBe("'abcd'");
  });

  it('pages with LIMIT and OFFSET, which the session turns into a query', () => {
    expect(paginate('SELECT * FROM `app`;', 100, 0)).toBe('SELECT * FROM `app` LIMIT 100');
    expect(paginate('SELECT * FROM `app`', 100, 200)).toBe(
      'SELECT * FROM `app` LIMIT 100 OFFSET 200',
    );
    expect(() => paginate('x', -1, 0)).toThrow(/Invalid page/u);
    expect(() => paginate('x', 1.5, 0)).toThrow(/Invalid page/u);
    expect(() => paginate('x', 1, -2)).toThrow(/Invalid page/u);
  });

  it('refuses to design, drop, rename, truncate, dump, insert or match with LIKE', () => {
    const { ddl, dump } = lokiDialect;
    const table = { name: 'app' };
    const refusals = [
      () => ddl.createTable(table, {} as never),
      () => ddl.alterTable(table, {} as never, {} as never, {} as never),
      () => ddl.dropRelation(table, 'table'),
      () => ddl.renameRelation(table, 'table', 'x'),
      () => ddl.truncateTable(table),
      () => ddl.dropObject({ kind: 'function', name: 'f' }),
      () => ddl.replaceObject({ kind: 'function', name: 'f' }, [], []),
      () => dump.insert('`app`', [], [], false),
      () => dump.insertSelect('`app`', [], 'SELECT 1', false),
      () => dump.dropRelations([table], 'table'),
      () => dump.dropObject({ kind: 'function', name: 'f' }),
      () => lokiDialect.likeText('a', 'b'),
      () => lokiDialect.insertDefaultRow('`app`'),
    ];
    for (const refuse of refusals) {
      expect(refuse).toThrow(/Loki has no/u);
    }
    expect(lokiDialect.defaultKeyword).toBe(false);
  });

  it('shares the keywords of LogQL', () => {
    expect(lokiDialect.keywords).toContain('by');
    expect(lokiDialect.keywords).not.toContain('SELECT');
  });
});
