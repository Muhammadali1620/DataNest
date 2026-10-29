import { describe, expect, it } from 'vitest';
import {
  isCopyFromStdin,
  ScriptReader,
  type ScriptItem,
} from '../../../../src/core/sql/script-reader';
import type { DriverId } from '../../../../src/shared/connection';

/** Feeds the script in parts of `size` characters and collects every item. */
function readInParts(sql: string, driver: DriverId | undefined, size: number): ScriptItem[] {
  const reader = new ScriptReader(driver);
  const items: ScriptItem[] = [];
  for (let offset = 0; offset < sql.length; offset += size) {
    items.push(...reader.push(sql.slice(offset, offset + size)));
  }
  items.push(...reader.end());
  return items;
}

function readWhole(sql: string, driver?: DriverId): ScriptItem[] {
  return readInParts(sql, driver, Math.max(1, sql.length));
}

/** The same items come out however the text is cut. */
function expectStable(sql: string, driver?: DriverId): ScriptItem[] {
  const whole = readWhole(sql, driver);
  for (const size of [1, 2, 3, 7, 16, 64]) {
    expect(readInParts(sql, driver, size), `parts of ${size}`).toEqual(whole);
  }
  return whole;
}

describe('ScriptReader', () => {
  it('reads statements with their first line', () => {
    const items = expectStable('SELECT 1;\n\nSELECT\n  2;\nSELECT 3');
    expect(items).toEqual([
      { kind: 'statement', text: 'SELECT 1', line: 1 },
      { kind: 'statement', text: 'SELECT\n  2', line: 3 },
      { kind: 'statement', text: 'SELECT 3', line: 5 },
    ]);
  });

  it('gives out a statement only once it is followed by more, or the text ends', () => {
    const reader = new ScriptReader('mysql');
    expect(reader.push('SELECT 1;\n')).toEqual([]);
    expect(reader.push('SELECT 2;\n')).toEqual([{ kind: 'statement', text: 'SELECT 1', line: 1 }]);
    expect(reader.end()).toEqual([{ kind: 'statement', text: 'SELECT 2', line: 2 }]);
  });

  it('keeps semicolons inside strings and comments, wherever the text is cut', () => {
    const sql = "INSERT INTO t VALUES ('a;b', 'it''s;');\n-- c;\n/* d;\n e; */ SELECT ';';\n";
    expect(expectStable(sql, 'postgres').map((item) => item.text)).toEqual([
      "INSERT INTO t VALUES ('a;b', 'it''s;')",
      "SELECT ';'",
    ]);
  });

  it('carries a MySQL DELIMITER from one part to the next', () => {
    const sql = [
      'DELIMITER //',
      'CREATE PROCEDURE p()',
      'BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END//',
      'DELIMITER ;',
      'CALL p();',
      '',
    ].join('\n');
    expect(expectStable(sql, 'mysql')).toEqual([
      {
        kind: 'statement',
        text: 'CREATE PROCEDURE p()\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND',
        line: 2,
      },
      { kind: 'statement', text: 'CALL p()', line: 8 },
    ]);
  });

  it('keeps PostgreSQL dollar-quoted bodies whole', () => {
    const sql =
      'CREATE FUNCTION f() RETURNS int AS $body$\nBEGIN\n  RETURN 1;\nEND;\n$body$ LANGUAGE plpgsql;\nSELECT f();\n';
    expect(expectStable(sql, 'postgres').map((item) => item.line)).toEqual([1, 6]);
  });

  it('keeps SQLite trigger bodies whole', () => {
    const sql =
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1;\n  DELETE FROM u;\nEND;\nSELECT 1;';
    expect(expectStable(sql, 'sqlite').map((item) => item.text)).toEqual([
      'CREATE TRIGGER tr AFTER INSERT ON t BEGIN\n  UPDATE t SET a = 1;\n  DELETE FROM u;\nEND',
      'SELECT 1',
    ]);
  });

  it('starts a statement at its code, after the comments before it', () => {
    const items = expectStable('-- header\n/* about t */\n  CREATE TABLE t (a int);\n', 'sqlite');
    expect(items).toEqual([{ kind: 'statement', text: 'CREATE TABLE t (a int)', line: 3 }]);
  });

  it('runs mysqldump executable comments', () => {
    const sql =
      '-- MySQL dump\n/*!40101 SET NAMES utf8mb4 */;\n/*!40014 SET FOREIGN_KEY_CHECKS=0 */;\nSELECT 1;\n';
    expect(expectStable(sql, 'mysql').map((item) => [item.text, item.line])).toEqual([
      ['/*!40101 SET NAMES utf8mb4 */', 2],
      ['/*!40014 SET FOREIGN_KEY_CHECKS=0 */', 3],
      ['SELECT 1', 4],
    ]);
  });

  it('counts lines across Windows line endings', () => {
    const items = expectStable('SELECT 1;\r\nSELECT 2;\r\n\r\nSELECT 3;\r\n');
    expect(items.map((item) => item.line)).toEqual([1, 2, 4]);
  });

  it('gives nothing for empty text, blanks or comments only', () => {
    expect(expectStable('')).toEqual([]);
    expect(expectStable('\n\n  \n')).toEqual([]);
    expect(expectStable('-- one\n/* two\n three */\n')).toEqual([]);
  });

  it('does not drop a comment that is still open at the end of a part', () => {
    const reader = new ScriptReader('postgres');
    expect(reader.push('/* begins here\nSELECT 1;\n')).toEqual([]);
    expect(reader.push('still a comment */ SELECT 2;\nSELECT 3;\n')).toEqual([
      { kind: 'statement', text: 'SELECT 2', line: 3 },
    ]);
    expect(reader.end()).toEqual([{ kind: 'statement', text: 'SELECT 3', line: 4 }]);
  });

  it('reads a statement far longer than one part', () => {
    const values = Array.from({ length: 20_000 }, (_, i) => `(${i}, 'v${i};')`).join(',\n');
    const sql = `INSERT INTO t VALUES\n${values};\nSELECT 1;\n`;
    const items = readInParts(sql, 'mysql', 1000);
    expect(items).toHaveLength(2);
    expect(items[0]?.text.length).toBe(sql.indexOf(';\nSELECT 1'));
    expect(items[1]).toEqual({ kind: 'statement', text: 'SELECT 1', line: 20_002 });
  });

  it('keeps the work linear for a long statement fed in small parts', () => {
    const sql = `INSERT INTO t VALUES ${Array.from({ length: 50_000 }, (_, i) => `(${i})`).join(', ')};`;
    const started = performance.now();
    expect(readInParts(sql, 'mysql', 256)).toHaveLength(1);
    // Splitting again on every part would take seconds; doubling keeps it quick.
    expect(performance.now() - started).toBeLessThan(2000);
  });

  describe('PostgreSQL dumps', () => {
    const dump = [
      '\\restrict k3y',
      "SET client_encoding = 'UTF8';",
      'COPY public.t (id, name) FROM stdin;',
      "1\tO'Brien; DROP TABLE t;",
      '2\t\\N',
      '\\.',
      'SELECT 1;',
      '\\unrestrict k3y',
      '',
    ].join('\n');

    it('reports psql commands and COPY, and skips the COPY data', () => {
      expect(expectStable(dump, 'postgres')).toEqual([
        { kind: 'psql-command', text: '\\restrict k3y', line: 1 },
        { kind: 'statement', text: "SET client_encoding = 'UTF8'", line: 2 },
        { kind: 'copy-from-stdin', text: 'COPY public.t (id, name) FROM stdin', line: 3 },
        { kind: 'statement', text: 'SELECT 1', line: 7 },
        { kind: 'psql-command', text: '\\unrestrict k3y', line: 8 },
      ]);
    });

    it('skips COPY data that runs to the end of the file', () => {
      const items = expectStable('COPY t FROM STDIN;\n1\t2\n3\t4', 'postgres');
      expect(items).toEqual([{ kind: 'copy-from-stdin', text: 'COPY t FROM STDIN', line: 1 }]);
    });

    it('goes on after empty COPY data', () => {
      const items = expectStable('COPY t FROM stdin;\n\\.\r\nSELECT 2;', 'postgres');
      expect(items.map((item) => [item.kind, item.line])).toEqual([
        ['copy-from-stdin', 1],
        ['statement', 3],
      ]);
    });

    it('leaves COPY and backslashes alone in other dialects', () => {
      const items = readWhole('COPY t FROM stdin;\n1\t2\n\\.\n', 'mysql');
      expect(items.every((item) => item.kind === 'statement')).toBe(true);
    });
  });
});

describe('ScriptReader: SQL Server (V6.2)', () => {
  it('reads GO-separated batches the same however the text is cut', () => {
    const sql = [
      'CREATE TABLE t (a INT);',
      'GO',
      'CREATE PROCEDURE p AS',
      'BEGIN',
      '  SELECT 1;',
      'END;',
      'GO',
      'DECLARE @n INT = 1;',
      'SELECT @n;',
      'GO',
      'SELECT 2;',
    ].join('\n');
    expect(expectStable(sql, 'mssql')).toEqual([
      { kind: 'statement', text: 'CREATE TABLE t (a INT)', line: 1 },
      { kind: 'statement', text: 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\nEND;', line: 3 },
      { kind: 'statement', text: 'DECLARE @n INT = 1;\nSELECT @n;', line: 8 },
      { kind: 'statement', text: 'SELECT 2', line: 11 },
    ]);
  });

  it('never lets a declaring batch out before its GO', () => {
    const reader = new ScriptReader('mssql');
    expect(reader.push('DECLARE @n INT;\nSELECT @n;\n')).toEqual([]);
    expect(reader.push('SELECT @n + 1;\n')).toEqual([]);
    expect([...reader.push('GO\nSELECT 2;\n'), ...reader.end()]).toEqual([
      { kind: 'statement', text: 'DECLARE @n INT;\nSELECT @n;\nSELECT @n + 1;', line: 1 },
      { kind: 'statement', text: 'SELECT 2', line: 5 },
    ]);
  });
});

describe('isCopyFromStdin', () => {
  it('recognizes COPY … FROM STDIN in any case and form', () => {
    expect(isCopyFromStdin('COPY public.t (a, b) FROM stdin')).toBe(true);
    expect(isCopyFromStdin('copy t from STDIN with (format csv)')).toBe(true);
  });

  it('refuses other COPY forms and look-alikes', () => {
    expect(isCopyFromStdin("COPY t FROM '/tmp/x.csv'")).toBe(false);
    expect(isCopyFromStdin('COPY t TO stdout')).toBe(false);
    expect(isCopyFromStdin("SELECT 'COPY t FROM stdin'")).toBe(false);
    expect(isCopyFromStdin('-- COPY t FROM stdin\nSELECT 1')).toBe(false);
  });
});
