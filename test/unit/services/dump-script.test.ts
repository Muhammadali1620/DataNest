import { describe, expect, it } from 'vitest';
import {
  commentLine,
  INSERT_CHARS,
  INSERT_ROWS,
  mentionedNames,
  orderViews,
  RowBatcher,
  scriptStatement,
} from '../../../src/services/dump-script';
import { splitStatements } from '../../../src/core/sql/split';

describe('scriptStatement: SQL Server (V6.2)', () => {
  it('puts every statement in a batch of its own', () => {
    expect(scriptStatement('  INSERT INTO [t] VALUES (1)  ', 'mssql')).toBe(
      'INSERT INTO [t] VALUES (1)\nGO\n',
    );
    expect(scriptStatement('CREATE VIEW v AS SELECT 1;', 'mssql')).toBe(
      'CREATE VIEW v AS SELECT 1;\nGO\n',
    );
  });

  it('reads bracketed names when ordering views', () => {
    expect(mentionedNames('SELECT * FROM [dbo].[Order]]s]', 'mssql')).toEqual(
      new Set(['select', 'from', 'dbo', 'order]s']),
    );
  });
});

describe('scriptStatement', () => {
  it('ends a statement with a semicolon and a line break', () => {
    expect(scriptStatement('  SELECT 1  ', 'postgres')).toBe('SELECT 1;\n');
  });

  it('wraps a MySQL body that holds semicolons in DELIMITER lines', () => {
    const body = 'CREATE PROCEDURE p() BEGIN SELECT 1; SELECT 2; END';
    const text = scriptStatement(body, 'mysql');
    expect(text).toBe(`DELIMITER //\n${body}//\nDELIMITER ;\n`);
    expect(splitStatements(text, 'mysql').map((statement) => statement.text)).toEqual([body]);
  });

  it('needs no DELIMITER for a single MySQL statement or other dialects', () => {
    expect(scriptStatement("SELECT ';'", 'mysql')).toBe("SELECT ';';\n");
    expect(scriptStatement('CREATE FUNCTION f() AS $$ SELECT 1; $$', 'postgres')).toBe(
      'CREATE FUNCTION f() AS $$ SELECT 1; $$;\n',
    );
  });
});

describe('commentLine', () => {
  it('keeps the comment on one line', () => {
    expect(commentLine('Table a\nDROP TABLE b')).toBe('-- Table a DROP TABLE b\n');
  });
});

describe('mentionedNames', () => {
  it('collects words and quoted names, but not strings or comments', () => {
    const names = mentionedNames(
      'SELECT a FROM "Orders" o JOIN `x``y` -- other\nWHERE b = \'items\'',
      undefined,
    );
    expect(names.has('orders')).toBe(true);
    expect(names.has('x`y')).toBe(true);
    expect(names.has('items')).toBe(false);
    expect(names.has('other')).toBe(false);
  });
});

describe('orderViews', () => {
  const view = (name: string, sql: string) => ({ name, sql });

  it('puts a view after the views it uses', () => {
    const views = [
      view('c', 'SELECT * FROM b'),
      view('b', 'SELECT * FROM a'),
      view('a', 'SELECT * FROM t'),
      view('d', 'SELECT 1'),
    ];
    expect(orderViews(views, 'postgres').map((v) => v.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('matches quoted and differently cased names', () => {
    const views = [view('Top', 'SELECT * FROM "Base"'), view('Base', 'SELECT 1')];
    expect(orderViews(views, 'postgres').map((v) => v.name)).toEqual(['Base', 'Top']);
  });

  it('keeps the given order for a cycle and for unrelated views', () => {
    const views = [view('x', 'SELECT * FROM y'), view('y', 'SELECT * FROM x'), view('z', '1')];
    expect(orderViews(views, 'mysql').map((v) => v.name)).toEqual(['y', 'x', 'z']);
    expect(orderViews([], 'mysql')).toEqual([]);
  });

  it('ignores a view that mentions its own name', () => {
    expect(orderViews([view('v', 'SELECT v FROM t')], 'sqlite').map((v) => v.name)).toEqual(['v']);
  });
});

describe('RowBatcher', () => {
  it('hands out a group every INSERT_ROWS rows', () => {
    const batcher = new RowBatcher();
    const groups: string[][] = [];
    for (let i = 0; i < INSERT_ROWS * 2 + 5; i += 1) {
      const group = batcher.add(`(${i})`);
      if (group !== undefined) {
        groups.push(group);
      }
    }
    expect(groups.map((group) => group.length)).toEqual([INSERT_ROWS, INSERT_ROWS]);
    expect(batcher.take()).toHaveLength(5);
    expect(batcher.take()).toEqual([]);
  });

  it('closes a group early once it holds many characters', () => {
    const batcher = new RowBatcher();
    const big = `('${'x'.repeat(INSERT_CHARS / 2)}')`;
    expect(batcher.add(big)).toBeUndefined();
    expect(batcher.add(big)).toHaveLength(2);
  });
});
