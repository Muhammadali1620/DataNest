import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatter } from '../../../src/services/formatter';
import {
  createBundleFormatterLoader,
  DEFAULT_FORMAT_STYLE,
  formatEdits,
  type FormatterModule,
  languageOf,
} from '../../../src/services/sql-format';

/** Upper-cases the statement, or fails on the word BROKEN. */
const shouting: FormatterModule = {
  format: (sql) => {
    if (sql.includes('broken')) {
      throw new Error('Parse error at broken');
    }
    return `${sql.toUpperCase()}\n`;
  },
};

function apply(
  text: string,
  edits: readonly { start: number; end: number; text: string }[],
): string {
  let out = text;
  for (const edit of [...edits].reverse()) {
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  }
  return out;
}

describe('languageOf', () => {
  it('maps drivers to formatter dialects and falls back to standard SQL', () => {
    expect(languageOf('mysql')).toBe('mysql');
    expect(languageOf('postgres')).toBe('postgresql');
    expect(languageOf('sqlite')).toBe('sqlite');
    expect(languageOf('mssql')).toBe('transactsql');
    expect(languageOf('clickhouse')).toBe('clickhouse');
    expect(languageOf(undefined)).toBe('sql');
  });

  it('formats T-SQL with brackets and TOP through the real formatter (V6.2)', () => {
    const text = formatter.format(
      'select top (5) [order id] from [dbo].[orders] where id=1',
      'transactsql',
      DEFAULT_FORMAT_STYLE,
    );
    expect(text).toContain('[order id]');
    expect(text).toContain('[dbo].[orders]');
    expect(text).toMatch(/TOP\s*\(5\)/u);
  });
});

describe('formatEdits', () => {
  it('formats each statement in its place and keeps what lies between them', () => {
    const text = 'select 1;\n\n\nselect 2 ;';
    const result = formatEdits(text, 'postgres', DEFAULT_FORMAT_STYLE, shouting);
    expect(apply(text, result.edits)).toBe('SELECT 1;\n\n\nSELECT 2 ;');
    expect(result.failed).toBe(0);
  });

  it('leaves a formatted statement without an edit', () => {
    expect(formatEdits('SELECT 1;', undefined, DEFAULT_FORMAT_STYLE, shouting).edits).toEqual([]);
  });

  it('skips statements it cannot read and says how many', () => {
    const text = 'select 1; broken here; select 3';
    const result = formatEdits(text, 'mysql', DEFAULT_FORMAT_STYLE, shouting);
    expect(apply(text, result.edits)).toBe('SELECT 1; broken here; SELECT 3');
    expect(result).toMatchObject({ failed: 1, reason: 'Parse error at broken' });
  });

  it('keeps MySQL DELIMITER commands, which the formatter does not know', () => {
    const text = 'DELIMITER //\ncreate procedure p() begin select 1; end//\nDELIMITER ;\n';
    const result = formatEdits(text, 'mysql', DEFAULT_FORMAT_STYLE, shouting);
    expect(apply(text, result.edits)).toBe(
      'DELIMITER //\nCREATE PROCEDURE P() BEGIN SELECT 1; END//\nDELIMITER ;\n',
    );
  });

  it('formats only the statements a range touches', () => {
    const text = 'select 1; select 2; select 3;';
    const result = formatEdits(text, undefined, DEFAULT_FORMAT_STYLE, shouting, {
      from: 11,
      to: 12,
    });
    expect(apply(text, result.edits)).toBe('select 1; SELECT 2; select 3;');
  });

  it('passes the dialect and the style to the formatter', () => {
    const format = vi.fn(() => 'X');
    const style = { ...DEFAULT_FORMAT_STYLE, keywordCase: 'lower' as const };
    formatEdits('select 1', 'sqlite', style, { format });
    expect(format).toHaveBeenCalledWith('select 1', 'sqlite', style);
  });
});

describe('the sql-formatter bundle', () => {
  it('formats with the style', () => {
    expect(
      formatter.format(
        'select a, b from t where x = 1 and y = 2',
        'postgresql',
        DEFAULT_FORMAT_STYLE,
      ),
    ).toBe('SELECT\n  a,\n  b\nFROM\n  t\nWHERE\n  x = 1\n  AND y = 2');
  });

  it('follows case, indentation and operator settings', () => {
    const text = formatter.format('SELECT a+1 FROM t WHERE x = 1 AND y = 2', 'mysql', {
      ...DEFAULT_FORMAT_STYLE,
      keywordCase: 'lower',
      logicalOperatorNewline: 'after',
      denseOperators: true,
      useTabs: true,
    });
    expect(text).toBe('select\n\ta+1\nfrom\n\tt\nwhere\n\tx=1 and\n\ty=2');
  });

  it('keeps comments, which belong to the statement they precede', () => {
    const text = 'select 1;\n-- the second one\nselect 2;';
    const result = formatEdits(text, 'postgres', DEFAULT_FORMAT_STYLE, formatter);
    expect(apply(text, result.edits)).toBe('SELECT\n  1;\n-- the second one\nSELECT\n  2;');
  });

  it('keeps PostgreSQL dollar-quoted bodies as they are', () => {
    const body = '$$ SELECT  1 ; $$';
    expect(
      formatter.format(
        `create function f() returns int language sql as ${body}`,
        'postgresql',
        DEFAULT_FORMAT_STYLE,
      ),
    ).toContain(body);
  });

  it('throws on text it cannot parse', () => {
    expect(() => formatter.format('SELECT (', 'sql', DEFAULT_FORMAT_STYLE)).toThrow();
  });
});

describe('createBundleFormatterLoader', () => {
  let dir: string | undefined;

  afterEach(() => {
    if (dir !== undefined) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads formatter.js next to the bundle once', () => {
    dir = mkdtempSync(join(tmpdir(), 'datanest-formatter-'));
    writeFileSync(
      join(dir, 'formatter.js'),
      'globalThis.__loads = (globalThis.__loads ?? 0) + 1; exports.formatter = { format: (s) => s + "!" };',
    );
    const load = createBundleFormatterLoader(join(dir, 'extension.js'));
    expect(load().format('x', 'sql', DEFAULT_FORMAT_STYLE)).toBe('x!');
    expect(load()).toBe(load());
    expect((globalThis as { __loads?: number }).__loads).toBe(1);
  });

  it('fails clearly when the bundle is missing', () => {
    const empty = mkdtempSync(join(tmpdir(), 'datanest-formatter-'));
    dir = empty;
    expect(() => createBundleFormatterLoader(join(empty, 'extension.js'))()).toThrow(
      /formatter\.js/,
    );
  });
});

describe('ClickHouse formatting (V6.3)', () => {
  it('formats through the real formatter in its own dialect', () => {
    const text = formatter.format(
      'select uniqExact(user_id) from hits final prewhere ts > now() - 60 settings max_threads=2',
      'clickhouse',
      DEFAULT_FORMAT_STYLE,
    );
    expect(text).toContain('SELECT');
    expect(text).toContain('FINAL');
    expect(text).toContain('PREWHERE');
  });
});
