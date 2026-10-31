// What the table properties page runs for the parts of a table the designer does not
// edit as a form: CHECK constraints and triggers. Pure, so every dialect is tested.

import type { ObjectRef, TableRef } from '../core/model/objects';
import { DbError } from '../core/errors';
import { msg } from '../core/user-message';
import type { Dialect } from '../drivers/driver';

/** Databases whose readers list CHECK constraints and whose ALTER can change them. */
const CHECK_DRIVERS: ReadonlySet<string> = new Set(['postgres', 'mysql', 'mssql']);

/** Databases without triggers of their own. */
const NO_TRIGGER_DRIVERS: ReadonlySet<string> = new Set(['clickhouse']);

export function checksSupported(driver: string): boolean {
  return CHECK_DRIVERS.has(driver);
}

export function triggersSupported(driver: string): boolean {
  return !NO_TRIGGER_DRIVERS.has(driver);
}

/** The condition of a check as typed: one expression, no statement terminator. */
export function checkExpressionProblem(expression: string): string | undefined {
  const text = expression.trim();
  if (text === '') {
    return msg('Enter the condition of the check');
  }
  if (text.includes(';')) {
    return msg('The condition is one expression, without a semicolon');
  }
  return undefined;
}

/** Adds a named CHECK. A leading `CHECK` of a pasted definition is accepted. */
export function addCheckSql(
  dialect: Dialect,
  table: TableRef,
  name: string,
  expression: string,
): string {
  const problem = checkExpressionProblem(expression);
  if (problem !== undefined) {
    throw new DbError('syntax', problem);
  }
  if (name.trim() === '') {
    throw new DbError('syntax', msg('Enter a name for the check'));
  }
  const body = expression
    .trim()
    .replace(/^check\s*(?=\()/i, '')
    .trim();
  const wrapped = wrapsWhole(body) ? body : `(${body})`;
  return `ALTER TABLE ${dialect.quoteTable(table)} ADD CONSTRAINT ${dialect.quoteIdentifier(name.trim())} CHECK ${wrapped}`;
}

/** True when the first parenthesis closes at the very end: `(a)` yes, `(a) AND (b)` no. */
function wrapsWhole(text: string): boolean {
  if (!text.startsWith('(')) {
    return false;
  }
  let depth = 0;
  let quote: string | undefined;
  for (let at = 0; at < text.length; at += 1) {
    const char = text.charAt(at);
    if (quote !== undefined) {
      // A doubled quote inside a literal is skipped as two closings and openings in a row.
      if (char === quote) {
        quote = undefined;
      }
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        return at === text.length - 1;
      }
    }
  }
  return false;
}

export function dropCheckSql(dialect: Dialect, table: TableRef, name: string): string {
  return `ALTER TABLE ${dialect.quoteTable(table)} DROP CONSTRAINT ${dialect.quoteIdentifier(name)}`;
}

export function triggerRef(table: TableRef, name: string): ObjectRef {
  return { ...table, kind: 'trigger', name, table: table.name };
}

/** A starting point for a new trigger, in the words of the database. */
export function triggerTemplate(driver: string, dialect: Dialect, table: TableRef): string {
  const target = dialect.quoteTable(table);
  const name = dialect.quoteIdentifier(`trg_${table.name}_audit`);
  switch (driver) {
    case 'postgres': {
      const fn = dialect.quoteIdentifier(`${table.name}_trigger_fn`);
      return [
        `CREATE OR REPLACE FUNCTION ${fn}() RETURNS trigger AS $$`,
        'BEGIN',
        '  -- NEW and OLD hold the row',
        '  RETURN NEW;',
        'END;',
        '$$ LANGUAGE plpgsql;',
        '',
        `CREATE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${target}`,
        `  FOR EACH ROW EXECUTE FUNCTION ${fn}();`,
      ].join('\n');
    }
    case 'mysql':
      return [
        `CREATE TRIGGER ${name} BEFORE INSERT ON ${target}`,
        'FOR EACH ROW',
        'BEGIN',
        '  -- NEW holds the row being written',
        '  SET @last_change = NOW();',
        'END',
      ].join('\n');
    case 'mssql':
      return [
        `CREATE TRIGGER ${name} ON ${target}`,
        'AFTER INSERT, UPDATE',
        'AS',
        'BEGIN',
        '  SET NOCOUNT ON;',
        '  -- inserted and deleted hold the rows',
        'END',
      ].join('\n');
    case 'oracle':
      return [
        `CREATE OR REPLACE TRIGGER ${name} BEFORE INSERT OR UPDATE ON ${target}`,
        'FOR EACH ROW',
        'BEGIN',
        '  NULL; -- :NEW and :OLD hold the row',
        'END;',
      ].join('\n');
    default:
      return [
        `CREATE TRIGGER ${name} AFTER INSERT ON ${target}`,
        'FOR EACH ROW',
        'BEGIN',
        '  SELECT 1; -- NEW and OLD hold the row',
        'END',
      ].join('\n');
  }
}
