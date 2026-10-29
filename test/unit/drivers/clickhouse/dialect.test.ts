import { describe, expect, it } from 'vitest';
import {
  clickhouseDialect,
  clickhousePattern,
  literal,
  paginate,
} from '../../../../src/drivers/clickhouse/dialect';
import { buildWhere } from '../../../../src/services/table-filter-sql';

describe('clickhouse literal', () => {
  it('writes NULL, booleans and numbers', () => {
    expect(literal(null)).toBe('NULL');
    expect(literal(true)).toBe('true');
    expect(literal(false)).toBe('false');
    expect(literal(-1.5)).toBe('-1.5');
    expect(literal(Number.NaN)).toBe('nan');
    expect(literal(Number.POSITIVE_INFINITY)).toBe('inf');
    expect(literal(Number.NEGATIVE_INFINITY)).toBe('-inf');
  });

  it('quotes strings with backslash escapes', () => {
    expect(literal("O'Brien")).toBe("'O\\'Brien'");
  });

  it('writes exact numbers bare and quotes anything else', () => {
    expect(literal({ kind: 'bigint', text: '18446744073709551615' })).toBe('18446744073709551615');
    expect(literal({ kind: 'decimal', text: '-12.50' })).toBe('-12.50');
    expect(literal({ kind: 'decimal', text: 'NaN' })).toBe("'NaN'");
    expect(literal({ kind: 'datetime', text: '2024-01-01 00:00:00' })).toBe(
      "'2024-01-01 00:00:00'",
    );
  });

  it('writes JSON of arrays and maps in the text the server parses into them', () => {
    expect(literal({ kind: 'json', text: '[1,2,3]' })).toBe("'[1, 2, 3]'");
    expect(literal({ kind: 'json', text: '{"one":1,"two":"b"}' })).toBe(
      "'{\\'one\\': 1, \\'two\\': \\'b\\'}'",
    );
    expect(literal({ kind: 'json', text: '"plain"' })).toBe('\'"plain"\'');
    expect(literal({ kind: 'json', text: 'not json' })).toBe("'not json'");
  });

  it('writes bytes as unhex', () => {
    expect(literal({ kind: 'binary', size: 2, preview: 'cafe' })).toBe("unhex('cafe')");
  });
});

describe('clickhouse paginate', () => {
  it('appends LIMIT, and OFFSET past the first page', () => {
    expect(paginate('SELECT 1;  ', 10, 0)).toBe('SELECT 1 LIMIT 10');
    expect(paginate('SELECT 1', 10, 20)).toBe('SELECT 1 LIMIT 10 OFFSET 20');
  });

  it('refuses a page that is not whole and positive', () => {
    expect(() => paginate('SELECT 1', -1, 0)).toThrow(/Invalid page/u);
    expect(() => paginate('SELECT 1', 1, 0.5)).toThrow(/Invalid page/u);
  });
});

describe('clickhousePattern', () => {
  it('turns the filter escapes into backslash escapes', () => {
    expect(clickhousePattern("'%a!_ice%'")).toBe("'%a\\\\_ice%'");
    expect(clickhousePattern("'50!%!_off%'")).toBe("'50\\\\%\\\\_off%'");
    expect(clickhousePattern("'!!x'")).toBe("'!x'");
  });

  it('escapes a backslash of the value and keeps wildcards and quotes', () => {
    expect(clickhousePattern("'%a\\\\b%'")).toBe("'%a\\\\\\\\b%'");
    expect(clickhousePattern("'%o\\'b%'")).toBe("'%o\\'b%'");
    expect(clickhousePattern("'_%'")).toBe("'_%'");
    expect(clickhousePattern("'a!'")).toBe("'a!'");
  });
});

describe('clickhouseDialect', () => {
  it('matches text without regard to case through ILIKE on the text form', () => {
    expect(clickhouseDialect.likeText('`name`', "'%a!_b%'")).toBe(
      "toString(`name`) ILIKE '%a\\\\_b%'",
    );
  });

  it('builds a filter that the server reads with its own escapes', () => {
    const where = buildWhere(clickhouseDialect, 'clickhouse', {
      conditions: [{ column: 'name', operator: 'contains', value: '50%_' }],
    });
    expect(where).toBe("toString(`name`) ILIKE '%50\\\\%\\\\_%'");
  });

  it('estimates rows from system.tables', () => {
    expect(clickhouseDialect.estimateRowsSql?.({ database: 'shop', name: 'o' })).toBe(
      "SELECT total_rows FROM system.tables WHERE database = 'shop' AND name = 'o'",
    );
    expect(clickhouseDialect.estimateRowsSql?.({ name: 'o' })).toBe(
      "SELECT total_rows FROM system.tables WHERE database = currentDatabase() AND name = 'o'",
    );
  });

  it('sets the session time zone', () => {
    expect(clickhouseDialect.setTimeZone?.('Europe/Berlin')).toBe(
      "SET session_timezone = 'Europe/Berlin'",
    );
  });

  it('inserts a row of defaults as an empty JSON object and has no DEFAULT keyword', () => {
    expect(clickhouseDialect.defaultKeyword).toBe(false);
    expect(clickhouseDialect.insertDefaultRow('`t`')).toBe('INSERT INTO `t` FORMAT JSONEachRow {}');
  });

  it('offers ClickHouse keywords', () => {
    expect(clickhouseDialect.keywords).toEqual(
      expect.arrayContaining(['PREWHERE', 'FINAL', 'ENGINE', 'LIMIT BY']),
    );
  });
});
