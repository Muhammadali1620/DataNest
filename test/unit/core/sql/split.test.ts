import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELIMITER,
  splitStatements,
  statementAt,
  statementsIn,
} from '../../../../src/core/sql/split';
import { ROOT } from '../../../helpers/repo';

/** Statement texts, which is what most expectations care about. */
function texts(sql: string, driver?: 'mysql' | 'postgres' | 'sqlite'): string[] {
  return splitStatements(sql, driver).map((statement) => statement.text);
}

describe('splitStatements', () => {
  it('splits on semicolons', () => {
    expect(texts('SELECT 1; SELECT 2')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('keeps the offsets of every statement', () => {
    const sql = 'SELECT 1;\n  SELECT 2;';
    const statements = splitStatements(sql);
    expect(statements).toEqual([
      { text: 'SELECT 1', start: 0, end: 8 },
      { text: 'SELECT 2', start: 12, end: 20 },
    ]);
    for (const statement of statements) {
      expect(sql.slice(statement.start, statement.end)).toBe(statement.text);
    }
  });

  it('handles a trailing semicolon and extra ones', () => {
    expect(texts('SELECT 1;')).toEqual(['SELECT 1']);
    expect(texts('SELECT 1;;;SELECT 2;;')).toEqual(['SELECT 1', 'SELECT 2']);
    expect(texts(';')).toEqual([]);
  });

  it('returns nothing for blank input or comments only', () => {
    expect(texts('')).toEqual([]);
    expect(texts('   \n\t ')).toEqual([]);
    expect(texts('-- just a note')).toEqual([]);
    expect(texts('/* and a block */')).toEqual([]);
    expect(texts('-- a;\n-- b;')).toEqual([]);
  });

  it('keeps comments that sit inside a statement', () => {
    expect(texts('SELECT 1 -- note\n, 2;')).toEqual(['SELECT 1 -- note\n, 2']);
    expect(texts('/* lead */ SELECT 1;')).toEqual(['/* lead */ SELECT 1']);
  });

  it('ignores semicolons inside strings and comments', () => {
    expect(texts("SELECT 'a;b';")).toEqual(["SELECT 'a;b'"]);
    expect(texts('SELECT 1 -- ;not here\n;')).toEqual(['SELECT 1 -- ;not here']);
    expect(texts('SELECT /* ; */ 1;')).toEqual(['SELECT /* ; */ 1']);
    expect(texts("SELECT 'O''Brien; still'")).toEqual(["SELECT 'O''Brien; still'"]);
  });

  it('ignores semicolons inside quoted names', () => {
    expect(texts('SELECT `a;b` FROM t;', 'mysql')).toEqual(['SELECT `a;b` FROM t']);
    expect(texts('SELECT "a;b" FROM t;', 'postgres')).toEqual(['SELECT "a;b" FROM t']);
  });

  it('keeps an unterminated string in one statement', () => {
    expect(texts("SELECT 'open; still open")).toEqual(["SELECT 'open; still open"]);
  });

  describe('PostgreSQL dollar quoting', () => {
    it('keeps a function body with semicolons in one statement', () => {
      const sql = [
        'CREATE FUNCTION f() RETURNS int AS $$',
        'BEGIN',
        '  RETURN 1;',
        'END;',
        '$$ LANGUAGE plpgsql;',
        'SELECT f();',
      ].join('\n');
      const statements = texts(sql, 'postgres');
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain('RETURN 1;');
      expect(statements[1]).toBe('SELECT f()');
    });

    it('handles tagged bodies', () => {
      const sql = 'DO $body$ BEGIN; END; $body$; SELECT 1;';
      expect(texts(sql, 'postgres')).toEqual(['DO $body$ BEGIN; END; $body$', 'SELECT 1']);
    });
  });

  describe('MySQL DELIMITER', () => {
    it('changes the terminator and is not part of any statement', () => {
      const sql = [
        'DELIMITER //',
        'CREATE PROCEDURE p()',
        'BEGIN',
        '  SELECT 1;',
        '  SELECT 2;',
        'END //',
        'DELIMITER ;',
        'SELECT 3;',
      ].join('\n');
      const statements = texts(sql, 'mysql');
      expect(statements).toHaveLength(2);
      expect(statements[0]).toContain('SELECT 1;');
      expect(statements[0]).toContain('END');
      expect(statements[0]).not.toContain('DELIMITER');
      expect(statements[1]).toBe('SELECT 3');
    });

    it('splits on the custom delimiter several times', () => {
      const sql = 'DELIMITER $$\nSELECT 1$$\nSELECT 2$$';
      expect(texts(sql, 'mysql')).toEqual(['SELECT 1', 'SELECT 2']);
    });

    it('ignores a semicolon while another delimiter is active', () => {
      expect(texts('DELIMITER //\nSELECT 1; SELECT 2//', 'mysql')).toEqual(['SELECT 1; SELECT 2']);
    });

    it('is a plain word in dialects without the command', () => {
      // In PostgreSQL `DELIMITER` has no special meaning for the client.
      expect(texts('DELIMITER //\nSELECT 1;', 'postgres')).toEqual(['DELIMITER //\nSELECT 1']);
    });

    it('is not treated as a command in the middle of a statement', () => {
      expect(texts('SELECT delimiter FROM t;', 'mysql')).toEqual(['SELECT delimiter FROM t']);
    });

    it('needs a delimiter after it', () => {
      expect(texts('DELIMITER\nSELECT 1;', 'mysql')).toEqual(['DELIMITER\nSELECT 1']);
    });

    it('works when the command is the last line', () => {
      expect(texts('SELECT 1;\nDELIMITER //', 'mysql')).toEqual(['SELECT 1']);
    });
  });

  it('exports the default delimiter it starts with', () => {
    expect(DEFAULT_DELIMITER).toBe(';');
  });
});

describe('statementAt', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3';

  it('finds the statement the cursor sits in', () => {
    expect(statementAt(sql, 0)?.text).toBe('SELECT 1');
    expect(statementAt(sql, 3)?.text).toBe('SELECT 1');
    expect(statementAt(sql, 12)?.text).toBe('SELECT 2');
    expect(statementAt(sql, sql.length)?.text).toBe('SELECT 3');
  });

  it('keeps the statement the cursor just ended with its semicolon', () => {
    // Right after `SELECT 1;` the user still means that statement.
    expect(statementAt(sql, 9)?.text).toBe('SELECT 1');
  });

  it('falls to the following statement once the cursor is on its line', () => {
    expect(statementAt(sql, 10)?.text).toBe('SELECT 2');
  });

  it('returns the only statement wherever the cursor is', () => {
    expect(statementAt('SELECT 1', 0)?.text).toBe('SELECT 1');
    expect(statementAt('SELECT 1', 8)?.text).toBe('SELECT 1');
  });

  it('has nothing to offer in a script without statements', () => {
    expect(statementAt('', 0)).toBeUndefined();
    expect(statementAt('-- note', 3)).toBeUndefined();
  });

  it('works with a custom delimiter', () => {
    const script = 'DELIMITER //\nSELECT 1//\nSELECT 2//';
    expect(statementAt(script, script.indexOf('SELECT 2'), 'mysql')?.text).toBe('SELECT 2');
  });
});

describe('statementsIn', () => {
  const sql = 'SELECT 1;\nSELECT 2;\nSELECT 3;';

  it('returns the statement under the cursor for an empty selection', () => {
    expect(statementsIn(sql, 2, 2).map((s) => s.text)).toEqual(['SELECT 1']);
  });

  it('returns every statement a selection touches', () => {
    const from = sql.indexOf('SELECT 1') + 2;
    const to = sql.indexOf('SELECT 2') + 2;
    expect(statementsIn(sql, from, to).map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('accepts a selection made backwards', () => {
    const from = sql.indexOf('SELECT 2') + 2;
    const to = sql.indexOf('SELECT 1') + 2;
    expect(statementsIn(sql, from, to).map((s) => s.text)).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('returns everything for a whole-document selection', () => {
    expect(statementsIn(sql, 0, sql.length)).toHaveLength(3);
  });

  it('returns nothing when the selection holds no statement', () => {
    expect(statementsIn('-- only a note', 0, 14)).toEqual([]);
  });
});

describe('against the real seed scripts', () => {
  function seed(name: string): string {
    return readFileSync(join(ROOT, 'docker/seed', name), 'utf8');
  }

  it('splits the MySQL seed, keeping routine bodies whole', () => {
    const sql = seed('mysql/01-schema.sql');
    const statements = splitStatements(sql, 'mysql');
    expect(statements.length).toBeGreaterThan(10);
    // No statement may carry the client command or a bare body terminator.
    for (const statement of statements) {
      expect(statement.text.toUpperCase().startsWith('DELIMITER')).toBe(false);
      expect(statement.text.endsWith('//')).toBe(false);
    }
    const routines = statements.filter((statement) =>
      /^CREATE (FUNCTION|PROCEDURE|TRIGGER)/i.test(statement.text),
    );
    expect(routines).toHaveLength(3);
    for (const routine of routines) {
      // A body kept whole still contains its inner semicolons.
      expect(routine.text).toContain(';');
      expect(routine.text.toUpperCase()).toContain('END');
    }
  });

  it('splits the PostgreSQL seed, keeping dollar-quoted bodies whole', () => {
    const sql = seed('postgres/01-schema.sql');
    const statements = splitStatements(sql, 'postgres');
    expect(statements.length).toBeGreaterThan(10);
    const dollar = statements.filter((statement) => statement.text.includes('$$'));
    for (const statement of dollar) {
      // An even number of markers means no body was cut in half.
      expect((statement.text.match(/\$\$/g) ?? []).length % 2).toBe(0);
    }
  });

  it('covers the whole script: every statement maps back to its source text', () => {
    for (const [name, driver] of [
      ['mysql/01-schema.sql', 'mysql'],
      ['postgres/01-schema.sql', 'postgres'],
    ] as const) {
      const sql = seed(name);
      for (const statement of splitStatements(sql, driver)) {
        expect(sql.slice(statement.start, statement.end)).toBe(statement.text);
      }
    }
  });
});
