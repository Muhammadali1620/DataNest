// CHECK constraints of a SQLite table. SQLite keeps no list of them: they exist only
// inside the CREATE TABLE text of sqlite_master, so they are read from there, and an
// added or dropped one is a rebuild of the table (ALTER cannot touch a constraint).

import { DbError } from '../../core/errors';
import { unquote } from '../../core/sql/completion-context';
import { isTrivia, syntaxOf, textOf, tokenize, type Token } from '../../core/sql/tokenizer';
import type { CheckConstraint, TableRef, TableStructure } from '../../core/model/objects';
import { msg } from '../../core/user-message';
import type { AlterPlan } from '../driver';
import { quoteIdentifier, quoteTable } from './quote';

/** What a check without a name of its own is called on the page: its place in the text. */
const UNNAMED = 'unnamed_check_';

/** A CHECK found in the CREATE text, with the span that removes it. */
interface FoundCheck {
  readonly name: string;
  readonly named: boolean;
  /** `(…)` as written. */
  readonly expression: string;
  /** From `CONSTRAINT name` (or `CHECK`) to the closing parenthesis. */
  readonly start: number;
  readonly end: number;
  /** Alone in its item of the column list: a table constraint, not part of a column. */
  readonly itemStart: number;
  readonly itemEnd: number;
  readonly alone: boolean;
}

interface Layout {
  readonly sql: string;
  /** Offset just after the table name's last token, where the column list `(` starts. */
  readonly nameStart: number;
  readonly open: number;
  readonly close: number;
  readonly checks: readonly FoundCheck[];
  /** End of the last item of the column list. */
  readonly lastItemEnd: number;
}

// `[name]` quotes an identifier in SQLite too; the scanner of the dialect leaves it out.
const SYNTAX = { ...syntaxOf('sqlite'), bracketIdentifiers: true };

function lay(sql: string): Layout | undefined {
  const tokens = tokenize(sql, SYNTAX).filter((token) => !isTrivia(token));
  const words = (token: Token | undefined): string =>
    token?.kind === 'word' ? textOf(sql, token).toUpperCase() : '';
  const table = tokens.findIndex((token) => words(token) === 'TABLE');
  if (table < 0) {
    return undefined;
  }
  const open = tokens.findIndex(
    (token, at) => at > table && token.kind === 'punctuation' && textOf(sql, token) === '(',
  );
  const first = tokens[table + 1];
  if (open < 0 || first === undefined) {
    return undefined;
  }
  // The column list: items split by commas at the top level, up to the matching `)`.
  const items: { from: number; to: number }[] = [];
  let depth = 0;
  let from = open + 1;
  let close = -1;
  for (let at = open; at < tokens.length; at += 1) {
    const token = tokens[at];
    const char = token?.kind === 'punctuation' ? textOf(sql, token) : '';
    if (char === '(') {
      depth += 1;
    } else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        items.push({ from, to: at });
        close = at;
        break;
      }
    } else if (char === ',' && depth === 1) {
      items.push({ from, to: at });
      from = at + 1;
    }
  }
  const closeToken = tokens[close];
  const openToken = tokens[open];
  if (closeToken === undefined || openToken === undefined) {
    return undefined;
  }
  const checks: FoundCheck[] = [];
  let ordinal = 0;
  for (const item of items) {
    if (item.from >= item.to) {
      continue;
    }
    const itemTokens = tokens.slice(item.from, item.to);
    const itemStart = itemTokens[0]?.start ?? 0;
    const itemEnd = itemTokens[itemTokens.length - 1]?.end ?? itemStart;
    let level = 0;
    for (let at = 0; at < itemTokens.length; at += 1) {
      const token = itemTokens[at];
      if (token === undefined) {
        continue;
      }
      const char = token.kind === 'punctuation' ? textOf(sql, token) : '';
      if (char === '(') {
        level += 1;
        continue;
      }
      if (char === ')') {
        level -= 1;
        continue;
      }
      if (
        level !== 0 ||
        words(token) !== 'CHECK' ||
        textOf(sql, itemTokens[at + 1] ?? token) !== '('
      ) {
        continue;
      }
      // Find the closing parenthesis of the condition.
      let inner = 0;
      let end = at + 1;
      for (; end < itemTokens.length; end += 1) {
        const piece = itemTokens[end];
        const text = piece?.kind === 'punctuation' ? textOf(sql, piece) : '';
        inner += text === '(' ? 1 : text === ')' ? -1 : 0;
        if (inner === 0) {
          break;
        }
      }
      const last = itemTokens[end];
      const opening = itemTokens[at + 1];
      if (last === undefined || opening === undefined) {
        continue;
      }
      // `CONSTRAINT name` before it gives the check its name.
      let begin = token.start;
      let given: string | undefined;
      const nameToken = itemTokens[at - 1];
      if (at >= 2 && words(itemTokens[at - 2]) === 'CONSTRAINT' && nameToken !== undefined) {
        given = unquote(textOf(sql, nameToken));
        begin = itemTokens[at - 2]?.start ?? begin;
      }
      if (given === undefined) {
        ordinal += 1;
      }
      checks.push({
        name: given ?? `${UNNAMED}${ordinal}`,
        named: given !== undefined,
        expression: sql.slice(opening.start, last.end),
        start: begin,
        end: last.end,
        itemStart,
        itemEnd,
        alone: begin === itemStart,
      });
      at = end;
    }
  }
  const lastItem = items[items.length - 1];
  const lastItemEnd =
    lastItem === undefined ? openToken.end : (tokens[lastItem.to - 1]?.end ?? openToken.end);
  return {
    sql,
    nameStart: first.start,
    open: openToken.start,
    close: closeToken.start,
    checks,
    lastItemEnd,
  };
}

/** The CHECK constraints written in a CREATE TABLE text, in order. */
export function parseSqliteChecks(createSql: string): CheckConstraint[] {
  return (lay(createSql)?.checks ?? []).map((check) => ({
    name: check.name,
    expression: check.expression,
  }));
}

/** True for the label the page gives a check that has no name in the CREATE text. */
export function isUnnamedSqliteCheck(name: string): boolean {
  return /^unnamed_check_\d+$/.test(name);
}

/** What follows the column list of a CREATE TABLE: `WITHOUT ROWID`, `STRICT`, both. */
export function sqliteTableOptions(createSql: string): string {
  const layout = lay(createSql);
  if (layout === undefined) {
    return '';
  }
  return createSql
    .slice(layout.close + 1)
    .replace(/;\s*$/, '')
    .trim();
}

/** The CREATE text without the named check; throws when there is none of that name. */
export function withoutSqliteCheck(createSql: string, name: string): string {
  const layout = lay(createSql);
  const found =
    layout?.checks.find((check) => check.named && check.name === name) ??
    layout?.checks.find((check) => check.name === name);
  if (layout === undefined || found === undefined) {
    throw new DbError('not-found', msg('The check {0} does not exist', name));
  }
  const sql = layout.sql;
  if (!found.alone) {
    // Part of a column: take the whitespace before it along.
    const from = sql.slice(0, found.start).replace(/\s+$/, '').length;
    return sql.slice(0, from) + sql.slice(found.end);
  }
  // A constraint of its own: its item and one neighbouring comma go.
  const before = sql.slice(0, found.itemStart);
  const after = sql.slice(found.itemEnd);
  const comma = /^\s*,\s*/.exec(after);
  if (comma !== null) {
    return before + after.slice(comma[0].length);
  }
  const previous = /,\s*$/.exec(before);
  return (previous === null ? before : before.slice(0, before.length - previous[0].length)) + after;
}

/** The CREATE text with one more table constraint after the last item. */
export function withSqliteCheck(createSql: string, name: string, expression: string): string {
  const layout = lay(createSql);
  if (layout === undefined) {
    throw new DbError('unsupported', msg('Cannot read the definition of this table'));
  }
  if (layout.checks.some((check) => check.name === name)) {
    throw new DbError('syntax', msg('The check {0} exists already', name));
  }
  const body = expression
    .trim()
    .replace(/^check\s*(?=\()/i, '')
    .trim();
  const wrapped = wrapsWhole(body) ? body : `(${body})`;
  const item = `CONSTRAINT ${quoteIdentifier(name)} CHECK ${wrapped}`;
  return `${createSql.slice(0, layout.lastItemEnd)},\n  ${item}${createSql.slice(layout.lastItemEnd)}`;
}

/** True when the first parenthesis closes at the very end: `(a)` yes, `(a) AND (b)` no. */
function wrapsWhole(text: string): boolean {
  if (!text.startsWith('(')) {
    return false;
  }
  const tokens = tokenize(text, SYNTAX).filter((token) => !isTrivia(token));
  let depth = 0;
  for (const token of tokens) {
    const char = token.kind === 'punctuation' ? textOf(text, token) : '';
    depth += char === '(' ? 1 : char === ')' ? -1 : 0;
    if (depth === 0) {
      return token.end === text.length;
    }
  }
  return false;
}

/**
 * The statements that give the table a new CREATE text: a copy under another name,
 * the rows copied over, the old table dropped and the copy renamed, then the indexes
 * and triggers created again (the SQLite documentation's way to change a constraint).
 */
export function sqliteRebuildWith(
  table: TableRef,
  structure: TableStructure,
  createSql: string,
): AlterPlan {
  const layout = lay(createSql);
  if (layout === undefined) {
    throw new DbError('unsupported', msg('Cannot read the definition of this table'));
  }
  const scope = table.database === undefined ? {} : { database: table.database };
  const temporary = `${table.name}__datanest_rebuild`;
  // `CREATE TABLE <name> (…)`: whatever stood between TABLE and the list (IF NOT EXISTS,
  // a schema prefix) gives way to the copy's name.
  const head =
    createSql.slice(0, layout.nameStart) +
    `${quoteTable({ ...scope, name: temporary })} ` +
    createSql.slice(layout.open);
  const target = quoteTable({ ...scope, name: table.name });
  // Computed columns are not copied: the new table works them out itself.
  const names = structure.columns
    .filter((column) => !column.generated)
    .map((column) => quoteIdentifier(column.name))
    .join(', ');
  const statements = [
    // Without this, dropping the old table would cascade into other tables' rows.
    'PRAGMA foreign_keys = OFF',
    'BEGIN',
    // Views that read the table must survive the moment it does not exist.
    'PRAGMA legacy_alter_table = ON',
    head,
  ];
  if (names !== '') {
    statements.push(
      `INSERT INTO ${quoteTable({ ...scope, name: temporary })} (${names}) SELECT ${names} FROM ${target}`,
    );
  }
  statements.push(
    `DROP TABLE ${target}`,
    `ALTER TABLE ${quoteTable({ ...scope, name: temporary })} RENAME TO ${quoteIdentifier(table.name)}`,
    'PRAGMA legacy_alter_table = OFF',
    ...(structure.dependents ?? []).map((dependent) => dependent.sql),
    'COMMIT',
  );
  return {
    statements,
    notes: ['rebuild'],
    recovery: ['ROLLBACK', 'PRAGMA legacy_alter_table = OFF', 'PRAGMA foreign_keys = ON'],
  };
}

/** Adds or drops one CHECK by rebuilding the table from its own CREATE text. */
export function sqliteChangeCheck(
  table: TableRef,
  structure: TableStructure,
  change: { readonly action: 'add' | 'drop'; readonly name: string; readonly expression?: string },
): AlterPlan {
  const source = structure.createSql;
  if (source === undefined) {
    throw new DbError('unsupported', msg('Cannot read the definition of this table'));
  }
  const next =
    change.action === 'add'
      ? withSqliteCheck(source, change.name, change.expression ?? '')
      : withoutSqliteCheck(source, change.name);
  return sqliteRebuildWith(table, structure, next);
}
