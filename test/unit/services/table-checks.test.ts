import { describe, expect, it } from 'vitest';
import { clickhouseDialect } from '../../../src/drivers/clickhouse/dialect';
import { mssqlDialect } from '../../../src/drivers/mssql/dialect';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { oracleDialect } from '../../../src/drivers/oracle/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import {
  addCheckSql,
  checkExpressionProblem,
  checkPlanFor,
  checksSupported,
  dropCheckSql,
  triggerRef,
  triggersSupported,
  triggerTemplate,
} from '../../../src/services/table-checks';

describe('checks and triggers of the table page', () => {
  it('knows which databases have checks and triggers', () => {
    expect(['postgres', 'mysql', 'mssql', 'oracle', 'sqlite'].every(checksSupported)).toBe(true);
    expect(checksSupported('clickhouse')).toBe(false);
    expect(triggersSupported('clickhouse')).toBe(false);
    expect(['postgres', 'mysql', 'mssql', 'sqlite', 'oracle'].every(triggersSupported)).toBe(true);
  });

  it('rejects an empty condition and one with a semicolon', () => {
    expect(checkExpressionProblem('  ')).toBe('Enter the condition of the check');
    expect(checkExpressionProblem('a > 0; DROP TABLE t')).toBe(
      'The condition is one expression, without a semicolon',
    );
    expect(checkExpressionProblem('a > 0')).toBeUndefined();
  });

  it.each([
    [
      postgresDialect,
      { schema: 'public', name: 'o' },
      'ALTER TABLE "public"."o" ADD CONSTRAINT "ck" CHECK (a > 0)',
    ],
    [
      mysqlDialect,
      { database: 'shop', name: 'o' },
      'ALTER TABLE `shop`.`o` ADD CONSTRAINT `ck` CHECK (a > 0)',
    ],
    [
      mssqlDialect,
      { schema: 'dbo', name: 'o' },
      'ALTER TABLE [dbo].[o] ADD CONSTRAINT [ck] CHECK (a > 0)',
    ],
  ])('adds a check in the words of the dialect', (dialect, table, sql) => {
    expect(addCheckSql(dialect, table, 'ck', 'a > 0')).toBe(sql);
  });

  it('accepts a pasted CHECK (…) and does not wrap a parenthesised condition twice', () => {
    const table = { name: 'o' };
    expect(addCheckSql(postgresDialect, table, 'ck', 'CHECK ((a > 0))')).toBe(
      'ALTER TABLE "o" ADD CONSTRAINT "ck" CHECK ((a > 0))',
    );
    expect(addCheckSql(postgresDialect, table, 'ck', '(a > 0)')).toBe(
      'ALTER TABLE "o" ADD CONSTRAINT "ck" CHECK (a > 0)',
    );
    expect(addCheckSql(postgresDialect, table, 'ck', '(a > 0) AND (b > 0)')).toBe(
      'ALTER TABLE "o" ADD CONSTRAINT "ck" CHECK ((a > 0) AND (b > 0))',
    );
  });

  it('is not fooled by parentheses inside a string literal', () => {
    expect(addCheckSql(postgresDialect, { name: 'o' }, 'ck', "(a = ')') AND b")).toContain(
      "CHECK ((a = ')') AND b)",
    );
    expect(addCheckSql(postgresDialect, { name: 'o' }, 'ck', "(a = ')')")).toContain(
      "CHECK (a = ')')",
    );
  });

  it('quotes the name of a check, so a hostile name stays a name', () => {
    expect(addCheckSql(postgresDialect, { name: 'o' }, 'a"b', 'x > 0')).toContain('"a""b"');
    expect(dropCheckSql(mysqlDialect, { name: 'o' }, 'a`b')).toBe(
      'ALTER TABLE `o` DROP CONSTRAINT `a``b`',
    );
  });

  it('throws a syntax error for a bad check', () => {
    expect(() => addCheckSql(postgresDialect, { name: 'o' }, '', 'a > 0')).toThrow(
      'Enter a name for the check',
    );
    expect(() => addCheckSql(postgresDialect, { name: 'o' }, 'ck', '')).toThrow(
      'Enter the condition',
    );
  });

  it('points a trigger at its table', () => {
    expect(triggerRef({ schema: 'public', name: 'o' }, 't')).toEqual({
      schema: 'public',
      name: 't',
      kind: 'trigger',
      table: 'o',
    });
  });

  it.each([
    ['postgres', postgresDialect, 'CREATE TRIGGER "trg_o_audit" BEFORE INSERT OR UPDATE ON "o"'],
    ['mysql', mysqlDialect, 'CREATE TRIGGER `trg_o_audit` BEFORE INSERT ON `o`'],
    ['mssql', mssqlDialect, 'CREATE TRIGGER [trg_o_audit] ON [o]'],
    ['oracle', oracleDialect, 'CREATE OR REPLACE TRIGGER "trg_o_audit"'],
    ['sqlite', sqliteDialect, 'CREATE TRIGGER "trg_o_audit" AFTER INSERT ON "o"'],
    ['clickhouse', clickhouseDialect, 'CREATE TRIGGER'],
  ])('starts a %s trigger from a template', (driver, dialect, start) => {
    expect(triggerTemplate(driver, dialect, { name: 'o' })).toContain(start);
  });
});

describe('checkPlanFor', () => {
  const table = { name: 'products' };
  const structure = {
    columns: [
      { name: 'id', dataType: 'INTEGER', nullable: false, autoIncrement: false, generated: false },
    ],
    primaryKey: ['id'],
    indexes: [],
    foreignKeys: [],
    createSql: 'CREATE TABLE products (id INTEGER PRIMARY KEY)',
  };

  it('is one ALTER TABLE where the database has the statement', () => {
    expect(
      checkPlanFor(oracleDialect, { schema: 'APP', name: 'T' }, undefined, {
        action: 'add',
        name: 'ck',
        expression: 'a > 0',
      }),
    ).toEqual({
      statements: ['ALTER TABLE "APP"."T" ADD CONSTRAINT "ck" CHECK (a > 0)'],
      recovery: [],
    });
    expect(
      checkPlanFor(oracleDialect, { schema: 'APP', name: 'T' }, undefined, {
        action: 'drop',
        name: 'CK',
      }).statements,
    ).toEqual(['ALTER TABLE "APP"."T" DROP CONSTRAINT "CK"']);
  });

  it('is a rebuild of the table in SQLite, with a recovery for a failed one', () => {
    const plan = checkPlanFor(sqliteDialect, table, structure, {
      action: 'add',
      name: 'id_pos',
      expression: 'id > 0',
    });
    expect(plan.statements[0]).toBe('PRAGMA foreign_keys = OFF');
    expect(plan.statements[3]).toContain('CONSTRAINT "id_pos" CHECK (id > 0)');
    expect(plan.statements.at(-1)).toBe('COMMIT');
    expect(plan.recovery).toContain('ROLLBACK');
    const dropped = checkPlanFor(
      sqliteDialect,
      table,
      { ...structure, createSql: 'CREATE TABLE products (id INT, CONSTRAINT p CHECK (id > 0))' },
      { action: 'drop', name: 'p' },
    );
    expect(dropped.statements[3]).not.toContain('CHECK');
  });

  it('checks the condition the same way for every database, first', () => {
    expect(() =>
      checkPlanFor(sqliteDialect, table, structure, { action: 'add', name: 'x', expression: ' ' }),
    ).toThrow('Enter the condition of the check');
    expect(() =>
      checkPlanFor(sqliteDialect, table, structure, { action: 'add', name: '', expression: 'a' }),
    ).toThrow('Enter a name for the check');
  });

  it('asks to open the table again when SQLite has no structure to rebuild from', () => {
    expect(() =>
      checkPlanFor(sqliteDialect, table, undefined, { action: 'drop', name: 'p' }),
    ).toThrow(/Open the table again/);
  });
});
