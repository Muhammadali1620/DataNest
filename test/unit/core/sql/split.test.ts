import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELIMITER,
  splitScript,
  splitStatements,
  statementAt,
  statementIndexAt,
  statementsIn,
} from '../../../../src/core/sql/split';
import type { DriverId } from '../../../../src/shared/connection';
import { ROOT } from '../../../helpers/repo';

/** Statement texts, which is what most expectations care about. */
function texts(sql: string, driver?: DriverId): string[] {
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

  describe('SQLite trigger bodies', () => {
    const trigger = [
      'CREATE TRIGGER t AFTER INSERT ON x BEGIN',
      '  UPDATE x SET a = 1 WHERE id = NEW.id;',
      '  DELETE FROM y WHERE id = NEW.id;',
      'END',
    ].join('\n');

    it('keeps a trigger with several statements in its body as one statement', () => {
      expect(texts(`${trigger};\nSELECT 1;`, 'sqlite')).toEqual([trigger, 'SELECT 1']);
    });

    it('understands TEMP and TEMPORARY triggers', () => {
      for (const temp of ['TEMP', 'temporary']) {
        const sql = trigger.replace('CREATE TRIGGER', `CREATE ${temp} TRIGGER`);
        expect(texts(`${sql}; SELECT 2`, 'sqlite')).toEqual([sql, 'SELECT 2']);
      }
    });

    it('counts CASE … END inside the body, so it does not close the trigger early', () => {
      const sql = [
        'CREATE TRIGGER t BEFORE UPDATE ON x BEGIN',
        "  UPDATE x SET a = CASE WHEN NEW.b > 0 THEN 'p' ELSE 'n' END;",
        '  SELECT 1;',
        'END',
      ].join('\n');
      expect(texts(`${sql};SELECT 3`, 'sqlite')).toEqual([sql, 'SELECT 3']);
    });

    it('counts a CASE in the WHEN clause before the body', () => {
      const sql =
        'CREATE TRIGGER t AFTER UPDATE ON x WHEN CASE WHEN NEW.a THEN 1 END BEGIN SELECT 1; END';
      expect(texts(`${sql}; SELECT 4`, 'sqlite')).toEqual([sql, 'SELECT 4']);
    });

    it('ignores BEGIN and END words in strings and comments of the body', () => {
      const sql = "CREATE TRIGGER t AFTER INSERT ON x BEGIN\n  -- END;\n  SELECT 'END;';\nEND";
      expect(texts(`${sql}; SELECT 5`, 'sqlite')).toEqual([sql, 'SELECT 5']);
    });

    it('leaves BEGIN as a transaction statement outside triggers', () => {
      expect(texts('BEGIN; INSERT INTO x VALUES (1); END;', 'sqlite')).toEqual([
        'BEGIN',
        'INSERT INTO x VALUES (1)',
        'END',
      ]);
    });

    it('keeps an unfinished trigger body as one statement to the end', () => {
      const sql = 'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; SELECT 2;';
      expect(texts(sql, 'sqlite')).toEqual([
        'CREATE TRIGGER t AFTER INSERT ON x BEGIN SELECT 1; SELECT 2;',
      ]);
    });

    it('is not used in other dialects, where bodies need a delimiter or quotes', () => {
      expect(texts(`${trigger};`, 'postgres')).toHaveLength(3);
    });
  });

  it('exports the default delimiter it starts with', () => {
    expect(DEFAULT_DELIMITER).toBe(';');
  });
});

describe('splitScript', () => {
  it('starts with the delimiter it is given and reports the one in force at the end', () => {
    const split = splitScript('SELECT 1//\nDELIMITER ;\nSELECT 2;', 'mysql', { delimiter: '//' });
    expect(split.pieces.map((piece) => [piece.text, piece.delimiter])).toEqual([
      ['SELECT 1', '//'],
      ['SELECT 2', ';'],
    ]);
    expect(split.delimiter).toBe(';');
  });

  it('remembers the delimiter each piece began with', () => {
    const split = splitScript(
      'SELECT 1;\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT 1; END$$\n',
      'mysql',
    );
    expect(split.pieces.map((piece) => piece.delimiter)).toEqual([';', '$$']);
    expect(split.delimiter).toBe('$$');
  });

  it('keeps the default delimiter when nothing changes it', () => {
    expect(splitScript('SELECT 1').delimiter).toBe(DEFAULT_DELIMITER);
    expect(splitScript('').pieces).toEqual([]);
  });

  it('reads psql commands as lines of their own when asked', () => {
    const sql = '\\restrict abc\nCREATE TABLE t (id int);\n  \\connect other\nSELECT 1;';
    const split = splitScript(sql, 'postgres', { psqlCommands: true });
    expect(split.pieces.map((piece) => [piece.kind, piece.text])).toEqual([
      ['psql-command', '\\restrict abc'],
      ['statement', 'CREATE TABLE t (id int)'],
      ['psql-command', '\\connect other'],
      ['statement', 'SELECT 1'],
    ]);
    for (const piece of split.pieces) {
      expect(sql.slice(piece.start, piece.end)).toBe(piece.text);
    }
  });

  it('treats a backslash inside a statement or a string as part of it', () => {
    const sql = "SELECT 'a\\b'\n  \\ ;\nSELECT E'\\n';";
    const split = splitScript(sql, 'postgres', { psqlCommands: true });
    expect(split.pieces.map((piece) => piece.kind)).toEqual(['statement', 'statement']);
  });

  it('leaves psql commands to the server unless asked', () => {
    expect(splitScript('\\connect db\nSELECT 1;', 'postgres').pieces).toHaveLength(1);
  });

  it('runs MySQL executable comments as statements', () => {
    const sql = '/*!40101 SET NAMES utf8mb4 */;\n/* plain */;\n/*M!100616 SET NOTE_VERBOSITY=0 */;';
    expect(texts(sql, 'mysql')).toEqual([
      '/*!40101 SET NAMES utf8mb4 */',
      '/*M!100616 SET NOTE_VERBOSITY=0 */',
    ]);
  });

  it('keeps executable comments as comments elsewhere', () => {
    expect(texts('/*!40101 SET NAMES utf8mb4 */;', 'postgres')).toEqual([]);
    expect(texts('/*!40101 SET NAMES utf8mb4 */;', 'sqlite')).toEqual([]);
  });

  it('reads MySQL hash comments as comments when deciding what is code', () => {
    expect(texts('# only a comment\n;', 'mysql')).toEqual([]);
  });
});

describe('statementIndexAt', () => {
  const statements = splitStatements('SELECT 1;  SELECT 2;\n\nSELECT 3');
  const starts = statements.map((statement) => statement.start);

  it('finds the statement whose text holds the offset', () => {
    expect(statementIndexAt(statements, 3)).toBe(0);
    expect(statementIndexAt(statements, (starts[1] ?? 0) + 2)).toBe(1);
    expect(statementIndexAt(statements, (starts[2] ?? 0) + 8)).toBe(2);
  });

  it('gives the space after a statement to it, and a statement start to the new one', () => {
    expect(statementIndexAt(statements, 9)).toBe(0);
    expect(statementIndexAt(statements, (starts[1] ?? 0) - 1)).toBe(0);
    expect(statementIndexAt(statements, starts[1] ?? 0)).toBe(1);
  });

  it('gives text before the first statement to the first, and past the end to the last', () => {
    const leading = splitStatements('\n\n  SELECT 1; SELECT 2');
    expect(statementIndexAt(leading, 0)).toBe(0);
    expect(statementIndexAt(statements, 10_000)).toBe(2);
  });

  it('matches a plain scan at every offset', () => {
    const sql = '-- a\nSELECT 1;\n\nSELECT 2; SELECT 3;\n';
    const split = splitStatements(sql);
    // Each statement owns the text up to the next one's start.
    const scan = (offset: number): number =>
      split.reduce((owner, statement, index) => (statement.start <= offset ? index : owner), 0);
    for (let offset = 0; offset <= sql.length; offset++) {
      expect(statementIndexAt(split, offset)).toBe(scan(offset));
    }
  });

  it('is undefined without statements', () => {
    expect(statementIndexAt([], 0)).toBeUndefined();
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

describe('SQL Server batches (V6.2)', () => {
  const t = (sql: string): string[] => texts(sql, 'mssql');

  it('splits on semicolons like everywhere else', () => {
    expect(t('SELECT 1; SELECT 2;')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('ends a statement at a GO line, which belongs to no statement', () => {
    expect(t('SELECT 1\nGO\nSELECT 2\ngo\n')).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('accepts GO with spaces, a count or a comment', () => {
    expect(t('SELECT 1\n   GO 5  \nSELECT 2\nGO -- next\nSELECT 3')).toEqual([
      'SELECT 1',
      'SELECT 2',
      'SELECT 3',
    ]);
  });

  it('does not take GO inside a line, a string, a comment or a name for a separator', () => {
    expect(t("SELECT 'x\nGO\n' AS a")).toEqual(["SELECT 'x\nGO\n' AS a"]);
    expect(t('SELECT 1 /*\nGO\n*/ + 1')).toEqual(['SELECT 1 /*\nGO\n*/ + 1']);
    expect(t('SELECT 1 GO')).toEqual(['SELECT 1 GO']);
    expect(t('SELECT 1\nGO now')).toEqual(['SELECT 1\nGO now']);
    expect(t('SELECT [x\nGO\n] FROM t')).toEqual(['SELECT [x\nGO\n] FROM t']);
  });

  it('keeps a procedure body whole up to GO', () => {
    const sql = [
      'CREATE PROCEDURE p AS',
      'BEGIN',
      '  SELECT 1;',
      '  SELECT 2;',
      'END;',
      'GO',
      'EXEC p;',
    ].join('\n');
    expect(t(sql)).toEqual([
      'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\n  SELECT 2;\nEND;',
      'EXEC p',
    ]);
  });

  it('treats CREATE OR ALTER and ALTER of routines and triggers the same', () => {
    expect(
      t('CREATE OR ALTER FUNCTION f() RETURNS INT AS BEGIN RETURN 1; END; SELECT 1'),
    ).toHaveLength(1);
    expect(t('ALTER PROC p AS SELECT 1; SELECT 2')).toHaveLength(1);
    expect(t('CREATE TRIGGER tr ON t AFTER INSERT AS SELECT 1; SELECT 2')).toHaveLength(1);
  });

  it('runs a batch that declares variables to GO, statements before it stay apart', () => {
    expect(t('SELECT 0;\nDECLARE @n INT = 1;\nSELECT @n;\nGO\nSELECT 2;')).toEqual([
      'SELECT 0',
      'DECLARE @n INT = 1;\nSELECT @n;',
      'SELECT 2',
    ]);
  });

  it('does not end a statement inside BEGIN … END or CASE … END', () => {
    expect(t('IF 1 = 1 BEGIN SELECT 1; SELECT 2; END; SELECT 3')).toEqual([
      'IF 1 = 1 BEGIN SELECT 1; SELECT 2; END',
      'SELECT 3',
    ]);
    expect(t('BEGIN TRY SELECT 1; END TRY BEGIN CATCH SELECT 2; END CATCH; SELECT 3')).toEqual([
      'BEGIN TRY SELECT 1; END TRY BEGIN CATCH SELECT 2; END CATCH',
      'SELECT 3',
    ]);
  });

  it('does not count BEGIN TRAN or END CONVERSATION as blocks', () => {
    expect(t('BEGIN TRAN; UPDATE t SET a = 1; COMMIT;')).toEqual([
      'BEGIN TRAN',
      'UPDATE t SET a = 1',
      'COMMIT',
    ]);
    expect(t('BEGIN TRANSACTION; BEGIN DISTRIBUTED TRAN; SELECT 1')).toHaveLength(3);
    expect(t('BEGIN SELECT 1; END CONVERSATION @h; SELECT 2; END; SELECT 3')).toEqual([
      'BEGIN SELECT 1; END CONVERSATION @h; SELECT 2; END',
      'SELECT 3',
    ]);
  });

  it('goes on with an IF when the next statement starts with ELSE', () => {
    expect(t('IF @a = 1 SELECT 1; ELSE SELECT 2; SELECT 3')).toEqual([
      'IF @a = 1 SELECT 1; ELSE SELECT 2',
      'SELECT 3',
    ]);
  });

  it('closes everything open at GO', () => {
    expect(t('BEGIN\nSELECT 1;\nGO\nSELECT 2; SELECT 3')).toEqual([
      'BEGIN\nSELECT 1;',
      'SELECT 2',
      'SELECT 3',
    ]);
  });

  it('applies the T-SQL rules to SQL Server only', () => {
    expect(texts('BEGIN; SELECT 1; END', 'postgres')).toEqual(['BEGIN', 'SELECT 1', 'END']);
    expect(texts('SELECT 1\nGO\nSELECT 2', 'postgres')).toEqual(['SELECT 1\nGO\nSELECT 2']);
  });

  it('maps every statement back to its source', () => {
    const sql = seed();
    for (const statement of splitStatements(sql, 'mssql')) {
      expect(sql.slice(statement.start, statement.end)).toBe(statement.text);
      expect(statement.text).not.toMatch(/^GO\b/mu);
    }
  });

  function seed(): string {
    return readFileSync(join(ROOT, 'docker/seed/mssql/01-schema.sql'), 'utf8');
  }

  it('splits the SQL Server seed, keeping routine and trigger bodies whole', () => {
    const statements = splitStatements(seed(), 'mssql');
    const routines = statements.filter((s) => /^CREATE (FUNCTION|PROCEDURE|TRIGGER)/u.test(s.text));
    expect(routines).toHaveLength(4);
    for (const routine of routines) {
      expect(routine.text).toMatch(/END;?$/u);
    }
  });
});

describe('splitStatements: ClickHouse (V6.3)', () => {
  it('splits at semicolons outside escaped strings, comments and heredocs', () => {
    expect(
      texts(
        'SELECT \'a\\\';b\';\nSELECT 2 # c; d\n;\nSELECT $h$x;y$h$;\nINSERT INTO t FORMAT JSONEachRow {"a":";"}',
        'clickhouse',
      ),
    ).toEqual([
      "SELECT 'a\\';b'",
      'SELECT 2 # c; d',
      'SELECT $h$x;y$h$',
      'INSERT INTO t FORMAT JSONEachRow {"a":";"}',
    ]);
  });

  it('treats GO as a plain word', () => {
    expect(texts('SELECT 1\nGO\nSELECT 2', 'clickhouse')).toEqual(['SELECT 1\nGO\nSELECT 2']);
  });
});

describe('splitStatements: Oracle (V6.4)', () => {
  const t = (sql: string): string[] => texts(sql, 'oracle');
  const pieces = (sql: string): [string, string][] =>
    splitScript(sql, 'oracle', { sqlplusCommands: true }).pieces.map((piece) => [
      piece.kind,
      piece.text,
    ]);

  it('splits plain SQL on semicolons', () => {
    expect(t('SELECT 1 FROM dual; SELECT 2 FROM dual;')).toEqual([
      'SELECT 1 FROM dual',
      'SELECT 2 FROM dual',
    ]);
  });

  it('ends a statement at a line of nothing but `/`, spaces allowed', () => {
    expect(t('SELECT 1 FROM dual\n/\nSELECT 2 FROM dual\n  /  \nSELECT 3 FROM dual')).toEqual([
      'SELECT 1 FROM dual',
      'SELECT 2 FROM dual',
      'SELECT 3 FROM dual',
    ]);
    expect(t('SELECT 1 FROM dual\r\n/\r\nSELECT 2 FROM dual\r\n')).toEqual([
      'SELECT 1 FROM dual',
      'SELECT 2 FROM dual',
    ]);
  });

  it('runs a statement ended by both `;` and `/` only once', () => {
    expect(t('SELECT 1 FROM dual;\n/\n/\n')).toEqual(['SELECT 1 FROM dual']);
  });

  it('keeps the offsets of statements around a `/` line', () => {
    const sql = 'SELECT 1 FROM dual\n/\nSELECT 2 FROM dual';
    for (const statement of splitStatements(sql, 'oracle')) {
      expect(sql.slice(statement.start, statement.end)).toBe(statement.text);
    }
  });

  it('does not take a division, a comment or a slash inside a line for a terminator', () => {
    expect(t('SELECT a / b FROM t; SELECT 1 /* c */ FROM dual;')).toEqual([
      'SELECT a / b FROM t',
      'SELECT 1 /* c */ FROM dual',
    ]);
    expect(t('SELECT a\n/ b FROM t')).toEqual(['SELECT a\n/ b FROM t']);
    expect(t('SELECT a /\nb FROM t')).toEqual(['SELECT a /\nb FROM t']);
    expect(t("SELECT 'a\n/\nb' FROM dual")).toEqual(["SELECT 'a\n/\nb' FROM dual"]);
    expect(t('SELECT 1 /*\n/\n*/ FROM dual')).toEqual(['SELECT 1 /*\n/\n*/ FROM dual']);
    expect(t("SELECT q'[a\n/\nb]' FROM dual")).toEqual(["SELECT q'[a\n/\nb]' FROM dual"]);
  });

  it('ignores semicolons inside q-quoted strings', () => {
    expect(t("SELECT q'[a;b]' FROM dual; SELECT 2 FROM dual")).toEqual([
      "SELECT q'[a;b]' FROM dual",
      'SELECT 2 FROM dual',
    ]);
  });

  it('keeps an anonymous block whole up to `/`, its last semicolon included', () => {
    expect(t('BEGIN\n  NULL;\n  DELETE FROM t;\nEND;\n/\nSELECT 1 FROM dual;')).toEqual([
      'BEGIN\n  NULL;\n  DELETE FROM t;\nEND;',
      'SELECT 1 FROM dual',
    ]);
    expect(t('DECLARE\n  n NUMBER;\nBEGIN\n  n := 1;\nEND;\n/')).toEqual([
      'DECLARE\n  n NUMBER;\nBEGIN\n  n := 1;\nEND;',
    ]);
    expect(t('begin null; end;\n/\ndeclare x number; begin null; end;\n/')).toEqual([
      'begin null; end;',
      'declare x number; begin null; end;',
    ]);
  });

  it('runs an unfinished block to the end of the text', () => {
    expect(t('BEGIN NULL; END;')).toEqual(['BEGIN NULL; END;']);
    expect(t('BEGIN NULL; END;\nSELECT 1 FROM dual;')).toEqual([
      'BEGIN NULL; END;\nSELECT 1 FROM dual;',
    ]);
  });

  it('keeps routines, packages, triggers and types whole up to `/`', () => {
    for (const head of [
      'CREATE PROCEDURE p IS',
      'CREATE OR REPLACE PROCEDURE p IS',
      'CREATE OR REPLACE EDITIONABLE FUNCTION f RETURN NUMBER IS',
      'CREATE OR REPLACE NONEDITIONABLE PACKAGE pk AS',
      'CREATE OR REPLACE PACKAGE BODY pk AS',
      'CREATE EDITIONABLE PACKAGE BODY pk AS',
      'CREATE OR REPLACE TRIGGER trg BEFORE INSERT ON t FOR EACH ROW',
      'create or replace type body tp as',
    ]) {
      const body = `${head}\nBEGIN\n  NULL;\n  SELECT 1 INTO x FROM dual;\nEND;`;
      expect(t(`${body}\n/\nSELECT 2 FROM dual;`), head).toEqual([body, 'SELECT 2 FROM dual']);
    }
  });

  it('reads the head of a routine past comments between its words', () => {
    const sql =
      '-- note\nCREATE /* x */ OR REPLACE PACKAGE pk AS\n  PROCEDURE a;\nEND pk;\n/\nSELECT 1 FROM dual';
    expect(t(sql)).toEqual([
      '-- note\nCREATE /* x */ OR REPLACE PACKAGE pk AS\n  PROCEDURE a;\nEND pk;',
      'SELECT 1 FROM dual',
    ]);
  });

  it('keeps a type specification whole up to `/`', () => {
    expect(t('CREATE TYPE tp AS OBJECT (a NUMBER);\n/\nSELECT 1 FROM dual;')).toEqual([
      'CREATE TYPE tp AS OBJECT (a NUMBER);',
      'SELECT 1 FROM dual',
    ]);
  });

  it('splits tables, views, sequences and indexes on semicolons: they are not PL/SQL', () => {
    expect(
      t(
        [
          'CREATE TABLE t (a NUMBER);',
          'CREATE OR REPLACE VIEW v AS SELECT 1 a FROM dual;',
          'CREATE OR REPLACE EDITIONABLE VIEW w AS SELECT 2 b FROM dual;',
          'CREATE OR REPLACE FORCE VIEW x AS SELECT 3 c FROM dual;',
          'CREATE SEQUENCE s;',
          'CREATE INDEX i ON t (a);',
        ].join('\n'),
      ),
    ).toEqual([
      'CREATE TABLE t (a NUMBER)',
      'CREATE OR REPLACE VIEW v AS SELECT 1 a FROM dual',
      'CREATE OR REPLACE EDITIONABLE VIEW w AS SELECT 2 b FROM dual',
      'CREATE OR REPLACE FORCE VIEW x AS SELECT 3 c FROM dual',
      'CREATE SEQUENCE s',
      'CREATE INDEX i ON t (a)',
    ]);
  });

  it('treats `/` lines as division in other dialects', () => {
    expect(texts('SELECT 1\n/\n2', 'mysql')).toEqual(['SELECT 1\n/\n2']);
    expect(texts('BEGIN; SELECT 1; END;', 'postgres')).toEqual(['BEGIN', 'SELECT 1', 'END']);
  });

  it('reads SQL*Plus command lines as client pieces when asked', () => {
    const sql = [
      'SET DEFINE OFF',
      'SET SERVEROUTPUT ON',
      'set echo off',
      'PROMPT Creating; the table',
      'REM a note',
      'remark another',
      'WHENEVER SQLERROR EXIT SQL.SQLCODE',
      'SPOOL out.log',
      'CREATE TABLE t (a NUMBER);',
      'EXIT',
    ].join('\n');
    expect(pieces(sql)).toEqual([
      ['psql-command', 'SET DEFINE OFF'],
      ['psql-command', 'SET SERVEROUTPUT ON'],
      ['psql-command', 'set echo off'],
      ['psql-command', 'PROMPT Creating; the table'],
      ['psql-command', 'REM a note'],
      ['psql-command', 'remark another'],
      ['psql-command', 'WHENEVER SQLERROR EXIT SQL.SQLCODE'],
      ['psql-command', 'SPOOL out.log'],
      ['statement', 'CREATE TABLE t (a NUMBER)'],
      ['psql-command', 'EXIT'],
    ]);
    for (const piece of splitScript(sql, 'oracle', { sqlplusCommands: true }).pieces) {
      expect(sql.slice(piece.start, piece.end)).toBe(piece.text);
    }
  });

  it('leaves SET TRANSACTION, SET ROLE and other SQL to the server', () => {
    expect(pieces('SET TRANSACTION READ ONLY;\nSET ROLE ALL;\nQUIT')).toEqual([
      ['statement', 'SET TRANSACTION READ ONLY'],
      ['statement', 'SET ROLE ALL'],
      ['psql-command', 'QUIT'],
    ]);
  });

  it('does not take a command word inside a statement for a command', () => {
    expect(pieces('SELECT 1, prompt FROM t\nWHERE x = 1;\nUPDATE t\nSET LONG = 1;')).toEqual([
      ['statement', 'SELECT 1, prompt FROM t\nWHERE x = 1'],
      ['statement', 'UPDATE t\nSET LONG = 1'],
    ]);
    expect(pieces('SELECT 1 FROM dual\nPROMPT x;')).toEqual([
      ['statement', 'SELECT 1 FROM dual\nPROMPT x'],
    ]);
    expect(pieces('SELECT 1 FROM dual; PROMPT hi')).toEqual([
      ['statement', 'SELECT 1 FROM dual'],
      ['statement', 'PROMPT hi'],
    ]);
  });

  it('leaves EXIT inside a PL/SQL loop to the block', () => {
    const block = 'BEGIN\n  LOOP\n    EXIT WHEN x > 1;\n  END LOOP;\nEND;';
    expect(pieces(`${block}\n/\n`)).toEqual([['statement', block]]);
  });

  it('sends SQL*Plus lines to the server unless asked', () => {
    expect(texts('SET DEFINE OFF\nSELECT 1 FROM dual;', 'oracle')).toEqual([
      'SET DEFINE OFF\nSELECT 1 FROM dual',
    ]);
  });
});
