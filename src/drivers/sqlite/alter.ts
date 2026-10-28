// ALTER TABLE for SQLite. Renames, new nullable columns and plain indexes change in
// place; anything else (types, keys, order, dropped columns) rebuilds the table the
// way the SQLite documentation describes: a new table, the rows copied over, the
// old one dropped, the new one renamed, its indexes and triggers created again.

import { DbError } from '../../core/errors';
import { unquote } from '../../core/sql/completion-context';
import { syntaxOf, textOf, tokenize } from '../../core/sql/tokenizer';
import type { TableRef } from '../../core/model/objects';
import type { ColumnDesign, TableBackground, TableDesign } from '../../shared/table-design';
import { diffTables, isEmptyDiff, type TableDiff } from '../../shared/table-diff';
import { type AlterPlan, EMPTY_PLAN } from '../driver';
import { columnSql, createIndexSql } from '../common/design-sql';
import { sqliteCreateTable } from './create-table';
import { quoteIdentifier, quoteTable } from './quote';

/** A default ADD COLUMN accepts: a constant, never an expression such as CURRENT_TIMESTAMP. */
const CONSTANT = /^(-?\d+(\.\d+)?|'([^']|'')*'|null|true|false)$/i;

/** Automatic indexes behind UNIQUE and PRIMARY KEY cannot be dropped on their own. */
function isAutomatic(name: string | undefined): boolean {
  return name?.startsWith('sqlite_autoindex_') === true;
}

/** True when ADD COLUMN can add this column without a rebuild. */
function addsInPlace(column: ColumnDesign): boolean {
  const value = column.defaultValue.trim();
  if (column.primaryKey || column.autoIncrement || (value !== '' && !CONSTANT.test(value))) {
    return false;
  }
  return column.nullable || (value !== '' && value.toLowerCase() !== 'null');
}

/**
 * Rewrites the column names an index or trigger refers to, the way SQLite itself
 * does on RENAME COLUMN. Strings and comments are separate tokens, so a word inside
 * them is never touched.
 */
export function renameColumnsIn(sql: string, renames: ReadonlyMap<string, string>): string {
  if (renames.size === 0) {
    return sql;
  }
  let out = '';
  let from = 0;
  for (const token of tokenize(sql, syntaxOf('sqlite'))) {
    if (token.kind !== 'word' && token.kind !== 'quoted-identifier') {
      continue;
    }
    const renamed = renames.get(unquote(textOf(sql, token)).toLowerCase());
    if (renamed !== undefined) {
      out += sql.slice(from, token.start) + quoteIdentifier(renamed);
      from = token.end;
    }
  }
  return out + sql.slice(from);
}

function needsRebuild(diff: TableDiff): boolean {
  return (
    diff.order ||
    diff.primaryKey ||
    diff.dropped.length > 0 ||
    diff.droppedKeys.length > 0 ||
    diff.addedKeys.length > 0 ||
    diff.changed.some(
      (change) => change.type || change.nullable || change.defaultValue || change.autoIncrement,
    ) ||
    diff.added.some((column) => !addsInPlace(column)) ||
    diff.droppedIndexes.some((index) => isAutomatic(index.original))
  );
}

export function sqliteAlterTable(
  table: TableRef,
  before: TableDesign,
  after: TableDesign,
  background: TableBackground,
): AlterPlan {
  const diff = diffTables(before, after);
  if (isEmptyDiff(diff)) {
    return EMPTY_PLAN;
  }
  return needsRebuild(diff)
    ? rebuild(table, before, after, background, diff)
    : inPlace(table, after, diff);
}

function inPlace(table: TableRef, after: TableDesign, diff: TableDiff): AlterPlan {
  const target = quoteTable(table);
  // In an attached database the index is named with the prefix, the table without.
  const local = quoteIdentifier(table.name);
  const statements = ['BEGIN'];
  for (const index of diff.droppedIndexes) {
    statements.push(`DROP INDEX ${quoteTable({ ...table, name: index.original ?? index.name })}`);
  }
  for (const change of diff.changed.filter((c) => c.renamed)) {
    statements.push(
      `ALTER TABLE ${target} RENAME COLUMN ${quoteIdentifier(change.before.original ?? change.before.name)} TO ${quoteIdentifier(change.after.name.trim())}`,
    );
  }
  for (const column of diff.added) {
    statements.push(
      `ALTER TABLE ${target} ADD COLUMN ${columnSql(column, {
        quote: quoteIdentifier,
        autoIncrement: () => '',
        trailer: () => '',
      })}`,
    );
  }
  for (const index of diff.addedIndexes) {
    statements.push(
      createIndexSql(
        after,
        index,
        quoteIdentifier,
        local,
        quoteTable({ ...table, name: index.name.trim() }),
      ),
    );
  }
  if (diff.renamed) {
    statements.push(`ALTER TABLE ${target} RENAME TO ${quoteIdentifier(after.name.trim())}`);
  }
  statements.push('COMMIT');
  return { statements, notes: [], recovery: ['ROLLBACK'] };
}

function rebuild(
  table: TableRef,
  before: TableDesign,
  after: TableDesign,
  background: TableBackground,
  diff: TableDiff,
): AlterPlan {
  if (background.generatedColumns.length > 0) {
    throw new DbError(
      'unsupported',
      'This change needs the table to be rebuilt, and DataNest cannot rebuild a SQLite table with computed columns yet',
    );
  }
  const old = table.name;
  const temporary = `${after.name.trim()}__datanest_rebuild`;
  const scope = table.database === undefined ? {} : { database: table.database };
  const target = quoteTable({ ...scope, name: old });
  const [create] = sqliteCreateTable(
    { ...scope, name: temporary },
    { ...after, name: temporary, indexes: [] },
  );
  const keptIds = new Set(before.columns.map((column) => column.id));
  const kept = after.columns.filter((column) => keptIds.has(column.id));
  const renamed = diff.changed.filter((change) => change.renamed);
  const statements = [
    // Without this, dropping the old table would cascade into other tables' rows.
    'PRAGMA foreign_keys = OFF',
    'BEGIN',
    // Renaming in place first lets SQLite carry the new names into views and triggers.
    ...renamed.map(
      (change) =>
        `ALTER TABLE ${target} RENAME COLUMN ${quoteIdentifier(change.before.original ?? change.before.name)} TO ${quoteIdentifier(change.after.name.trim())}`,
    ),
    // Views that read the table must survive the moment it does not exist.
    'PRAGMA legacy_alter_table = ON',
    create ?? '',
  ];
  if (kept.length > 0) {
    const names = kept.map((column) => quoteIdentifier(column.name.trim())).join(', ');
    statements.push(
      `INSERT INTO ${quoteTable({ ...scope, name: temporary })} (${names}) SELECT ${names} FROM ${target}`,
    );
  }
  statements.push(
    `DROP TABLE ${target}`,
    `ALTER TABLE ${quoteTable({ ...scope, name: temporary })} RENAME TO ${quoteIdentifier(old)}`,
    'PRAGMA legacy_alter_table = OFF',
  );
  for (const index of after.indexes) {
    statements.push(
      createIndexSql(
        after,
        index,
        quoteIdentifier,
        quoteIdentifier(old),
        quoteTable({ ...scope, name: index.name.trim() }),
      ),
    );
  }
  // What the designer does not edit comes back as it was written, with new column names.
  const names = new Map(
    renamed.map((change) => [
      (change.before.original ?? change.before.name).toLowerCase(),
      change.after.name.trim(),
    ]),
  );
  statements.push(...background.rebuildSql.map((sql) => renameColumnsIn(sql, names)));
  if (diff.renamed) {
    statements.push(`ALTER TABLE ${target} RENAME TO ${quoteIdentifier(after.name.trim())}`);
  }
  statements.push('COMMIT');
  return {
    statements,
    notes: ['rebuild'],
    recovery: ['ROLLBACK', 'PRAGMA legacy_alter_table = OFF'],
  };
}
