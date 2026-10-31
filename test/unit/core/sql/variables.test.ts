import { describe, expect, it } from 'vitest';
import {
  findVariables,
  substituteVariables,
  variableNames,
  variableValue,
} from '../../../../src/core/sql/variables';
import { clickhouseDialect } from '../../../../src/drivers/clickhouse/dialect';
import { mssqlDialect } from '../../../../src/drivers/mssql/dialect';
import { mysqlDialect } from '../../../../src/drivers/mysql/dialect';
import { oracleDialect } from '../../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import type { DriverId } from '../../../../src/shared/connection';

function names(sql: string, driver?: DriverId): string[] {
  return findVariables(sql, driver).map((variable) => variable.name);
}

describe('findVariables', () => {
  it('finds :name where a value goes', () => {
    expect(names('SELECT * FROM t WHERE id = :id')).toEqual(['id']);
    expect(names('SELECT * FROM t WHERE id IN (:a,:b, :c)')).toEqual(['a', 'b', 'c']);
    expect(names(':first')).toEqual(['first']);
    expect(names('SELECT\n:on_new_line')).toEqual(['on_new_line']);
    expect(names('WHERE a>:low AND a<:high')).toEqual(['low', 'high']);
  });

  it('finds ${name}', () => {
    expect(names('SELECT * FROM t WHERE name = ${name}')).toEqual(['name']);
    expect(names('SELECT ${a}+${b}')).toEqual(['a', 'b']);
  });

  it('gives the offsets of the whole variable', () => {
    const sql = 'WHERE a = :id AND b = ${code}';
    const [colon, brace] = findVariables(sql);
    expect(sql.slice(colon?.start, colon?.end)).toBe(':id');
    expect(sql.slice(brace?.start, brace?.end)).toBe('${code}');
  });

  it('keeps every use, in order, even of the same name', () => {
    expect(names('SELECT :x, :y, :x, ${y}')).toEqual(['x', 'y', 'x', 'y']);
  });

  it('takes names with digits, underscores and letters of any language', () => {
    expect(names('SELECT :user_2, :имя, :_x')).toEqual(['user_2', 'имя', '_x']);
  });

  it('never looks inside strings, comments or quoted names', () => {
    expect(names("SELECT ':x', '${y}' -- :z\n/* :w ${v} */")).toEqual([]);
    expect(names('SELECT "a:b" FROM `c:d`', 'mysql')).toEqual([]);
    expect(names('SELECT 1 # :hash', 'mysql')).toEqual([]);
    expect(names('SELECT [a:b] FROM t', 'mssql')).toEqual([]);
    expect(names('SELECT $$ :x ${y} $$, $tag$ :z $tag$', 'postgres')).toEqual([]);
    expect(names("SELECT q'[ :x ]' FROM dual", 'oracle')).toEqual([]);
    expect(names("SELECT 'it\\'s :x'", 'mysql')).toEqual([]);
  });

  it('leaves alone what only looks like a variable', () => {
    // A cast, an assignment, a slice, a label, a ClickHouse parameter.
    expect(names('SELECT a::int, b :: text', 'postgres')).toEqual([]);
    expect(names('SET @x := 1; SELECT @y:=2', 'mysql')).toEqual([]);
    expect(names('SELECT arr[1:n], arr[lo:hi]', 'postgres')).toEqual([]);
    expect(names('loop_1: LOOP LEAVE loop_1; END LOOP', 'mysql')).toEqual([]);
    expect(names('SELECT {id:UInt32}', 'clickhouse')).toEqual([]);
    expect(names("SELECT x FROM t WHERE (a):b OR f(x):y OR 'q':z")).toEqual([]);
    expect(names('SELECT : spaced, :1, :')).toEqual([]);
  });

  it('wants ${name} exactly: a name and braces with nothing else', () => {
    expect(names('SELECT ${ spaced }, ${}, $x, ${a b}, ${unclosed')).toEqual([]);
    expect(names('SELECT $1, $2', 'postgres')).toEqual([]);
  });

  it('skips routine, trigger and package definitions, whose binds are the server’s', () => {
    expect(
      names('CREATE OR REPLACE TRIGGER t BEFORE INSERT ON x FOR EACH ROW BEGIN :new.id := 1; END;'),
    ).toEqual([]);
    expect(names('CREATE DEFINER = `me`@`%` PROCEDURE p() BEGIN SELECT :a; END', 'mysql')).toEqual(
      [],
    );
    expect(names('ALTER FUNCTION f RETURN NUMBER IS BEGIN RETURN :b; END;')).toEqual([]);
    expect(names('CREATE OR ALTER PROC p AS SELECT :c', 'mssql')).toEqual([]);
    expect(names('CREATE PACKAGE BODY pk AS x NUMBER := :d; END;')).toEqual([]);
    expect(names('create editionable type t as object (a number)')).toEqual([]);
    expect(names('CREATE EVENT e ON SCHEDULE EVERY 1 DAY DO SELECT :e', 'mysql')).toEqual([]);
  });

  it('still finds variables in other statements that start with CREATE', () => {
    expect(names('CREATE TABLE t AS SELECT * FROM s WHERE a = :a')).toEqual(['a']);
    expect(names('CREATE VIEW v AS SELECT ${limit}')).toEqual(['limit']);
  });

  it('finds variables in anonymous blocks, where binds are meant to be filled', () => {
    expect(names('BEGIN UPDATE t SET a = :a; END;', 'oracle')).toEqual(['a']);
  });

  it('copes with text that ends in the middle of things', () => {
    expect(names("SELECT ':x")).toEqual([]);
    expect(names('SELECT /* :x')).toEqual([]);
    expect(names('SELECT :')).toEqual([]);
    expect(names('SELECT $')).toEqual([]);
    expect(names('SELECT ${')).toEqual([]);
    expect(names('')).toEqual([]);
  });
});

describe('variableNames', () => {
  it('keeps each name once, in the order it first appears', () => {
    expect(variableNames(findVariables('SELECT :b, :a, :b, ${a}, :c'))).toEqual(['b', 'a', 'c']);
  });

  it('tells names apart by case', () => {
    expect(variableNames(findVariables('SELECT :id, :ID'))).toEqual(['id', 'ID']);
  });

  it('is empty without variables', () => {
    expect(variableNames([])).toEqual([]);
  });
});

describe('substituteVariables', () => {
  const values: Record<string, string> = { id: '42', name: "'Bob'", long: "'a long value'" };
  const valueOf = (name: string): string => values[name] ?? 'NULL';

  it('replaces every variable with its value', () => {
    const sql = 'SELECT * FROM t WHERE id = :id AND name = ${name} OR id = :id';
    const { text } = substituteVariables(sql, findVariables(sql), valueOf);
    expect(text).toBe("SELECT * FROM t WHERE id = 42 AND name = 'Bob' OR id = 42");
  });

  it('leaves text without variables as it is', () => {
    const result = substituteVariables('SELECT 1', [], valueOf);
    expect(result.text).toBe('SELECT 1');
    expect(result.toSource(5)).toBe(5);
  });

  it('maps positions back to the written text', () => {
    // `:id` (3) becomes `42` (2); `${long}` (7) becomes `'a long value'` (14).
    const sql = 'SELECT :id, ${long} FROM missing';
    const result = substituteVariables(sql, findVariables(sql), valueOf);
    expect(result.text).toBe("SELECT 42, 'a long value' FROM missing");
    // Before any value: unchanged.
    expect(result.toSource(3)).toBe(3);
    // Inside a value: the start of its variable.
    expect(result.toSource(result.text.indexOf('42'))).toBe(sql.indexOf(':id'));
    expect(result.toSource(result.text.indexOf('long'))).toBe(sql.indexOf('${long}'));
    // After the values: shifted back by what they added.
    expect(result.toSource(result.text.indexOf('missing'))).toBe(sql.indexOf('missing'));
    expect(result.toSource(result.text.indexOf(','))).toBe(sql.indexOf(','));
    // Right at the end of the text.
    expect(result.toSource(result.text.length)).toBe(sql.length);
  });

  it('places the variables in order whatever order they come in', () => {
    const sql = 'SELECT :id, :id';
    const found = findVariables(sql).reverse();
    expect(substituteVariables(sql, found, valueOf).text).toBe('SELECT 42, 42');
  });

  it('ignores a variable that overlaps one already placed', () => {
    const sql = 'SELECT :id';
    const result = substituteVariables(
      sql,
      [
        { name: 'id', start: 7, end: 10 },
        { name: 'name', start: 8, end: 10 },
      ],
      valueOf,
    );
    expect(result.text).toBe('SELECT 42');
  });

  it('maps past an empty value to past its variable, and never below zero', () => {
    const result = substituteVariables(':id x', findVariables(':id x'), () => '');
    expect(result.text).toBe(' x');
    expect(result.toSource(1)).toBe(4);
    expect(result.toSource(-5)).toBe(0);
  });
});

describe('variableValue', () => {
  it('reads NULL in any case and with spaces around', () => {
    expect(variableValue('NULL')).toBeNull();
    expect(variableValue('null')).toBeNull();
    expect(variableValue('  Null ')).toBeNull();
  });

  it('reads plainly written numbers exactly, as decimals', () => {
    for (const text of [
      '0',
      '42',
      '-7',
      '3.14',
      '-0.5',
      '1e10',
      '2.5E-3',
      '12345678901234567890',
    ]) {
      expect(variableValue(text)).toEqual({ kind: 'decimal', text });
    }
    expect(variableValue(' 42 ')).toEqual({ kind: 'decimal', text: '42' });
  });

  it('keeps codes that only look like numbers as text', () => {
    for (const text of ['007', '1.', '.5', '+1', '1,5', '0x1F', '1 000', 'NaN', 'Infinity']) {
      expect(variableValue(text)).toBe(text);
    }
  });

  it('takes text in single quotes as text, with doubled quotes inside', () => {
    expect(variableValue("'42'")).toBe('42');
    expect(variableValue("'NULL'")).toBe('NULL');
    expect(variableValue("'it''s'")).toBe("it's");
    expect(variableValue("''")).toBe('');
    expect(variableValue("  'padded'  ")).toBe('padded');
  });

  it('keeps any other text as it was typed', () => {
    expect(variableValue('Bob')).toBe('Bob');
    expect(variableValue('  two words ')).toBe('  two words ');
    expect(variableValue("O'Brien")).toBe("O'Brien");
    expect(variableValue("'unclosed")).toBe("'unclosed");
    expect(variableValue('')).toBe('');
  });
});

describe('variable values as literals of each dialect', () => {
  const dialects = {
    mysql: mysqlDialect,
    postgres: postgresDialect,
    sqlite: sqliteDialect,
    mssql: mssqlDialect,
    clickhouse: clickhouseDialect,
    oracle: oracleDialect,
  };

  it.each(Object.entries(dialects))('%s writes numbers bare and NULL as NULL', (_name, dialect) => {
    expect(dialect.literal(variableValue('42'))).toBe('42');
    expect(dialect.literal(variableValue('-3.5'))).toBe('-3.5');
    expect(dialect.literal(variableValue('12345678901234567890'))).toBe('12345678901234567890');
    expect(dialect.literal(variableValue('null'))).toBe('NULL');
  });

  it.each(Object.entries(dialects))(
    '%s quotes text so it cannot end the string',
    (_name, dialect) => {
      const literal = dialect.literal(variableValue("x' OR '1'='1"));
      expect(literal).not.toBe("'x' OR '1'='1'");
      expect(literal).toMatch(/'$/u);
      expect(dialect.literal(variableValue("'42'"))).toMatch(/'42'$/u);
    },
  );

  it('escapes backslashes where MySQL reads them', () => {
    expect(mysqlDialect.literal(variableValue('a\\')).endsWith("\\\\'")).toBe(true);
  });
});
