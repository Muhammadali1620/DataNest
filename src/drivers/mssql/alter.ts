// ALTER TABLE for SQL Server, one change per statement inside a transaction: DDL is
// transactional here, so either the whole design is applied or nothing is. A default
// is a constraint with a name the user rarely knows; it is found and dropped by the
// column it belongs to.

import { DbError } from '../../core/errors';
import type { TableRef } from '../../core/model/objects';
import { composeType, type TableBackground, type TableDesign } from '../../shared/table-design';
import { diffTables, isEmptyDiff } from '../../shared/table-diff';
import { type AlterPlan, EMPTY_PLAN } from '../driver';
import { columnList, createIndexSql, foreignKeySql } from '../common/design-sql';
import { schemaOf } from './catalog';
import { describeSql } from './definitions';
import { mssqlColumnSql, renameTarget, withoutRestrict } from './design';
import { quoteIdentifier, quoteString, quoteTable } from './quote';
import { msg } from '../../core/user-message';

/** Drops the default constraint of a column, whatever the server named it. */
export function dropDefaultSql(table: { schema: string; name: string }, column: string): string {
  const target = quoteString(quoteTable(table));
  return [
    'DECLARE @default sysname = (SELECT name FROM sys.default_constraints',
    `  WHERE parent_object_id = OBJECT_ID(${target})`,
    `    AND parent_column_id = COLUMNPROPERTY(OBJECT_ID(${target}), ${quoteString(column)}, 'ColumnId'))`,
    `DECLARE @drop nvarchar(max) = N'ALTER TABLE ' + ${target} + N' DROP CONSTRAINT ' + QUOTENAME(@default)`,
    'IF @default IS NOT NULL EXEC sys.sp_executesql @drop',
  ].join('\n');
}

/** Drops the primary key constraint, by its name when it is known. */
function dropPrimaryKeySql(
  table: { schema: string; name: string },
  name: string | undefined,
): string {
  if (name !== undefined) {
    return `ALTER TABLE ${quoteTable(table)} DROP CONSTRAINT ${quoteIdentifier(name)}`;
  }
  const target = quoteString(quoteTable(table));
  return [
    `DECLARE @key sysname = (SELECT name FROM sys.key_constraints WHERE parent_object_id = OBJECT_ID(${target}) AND type = 'PK')`,
    `DECLARE @drop nvarchar(max) = N'ALTER TABLE ' + ${target} + N' DROP CONSTRAINT ' + QUOTENAME(@key)`,
    'IF @key IS NOT NULL EXEC sys.sp_executesql @drop',
  ].join('\n');
}

export function mssqlAlterTable(
  table: TableRef,
  before: TableDesign,
  rawAfter: TableDesign,
  background: TableBackground,
): AlterPlan {
  const after = { ...rawAfter, foreignKeys: rawAfter.foreignKeys.map(withoutRestrict) };
  const diff = diffTables(before, after);
  if (isEmptyDiff(diff)) {
    return EMPTY_PLAN;
  }
  for (const change of diff.changed) {
    if (change.autoIncrement) {
      throw new DbError(
        'unsupported',
        msg(
          'SQL Server cannot add or remove IDENTITY on the existing column {0}',
          change.after.name.trim(),
        ),
      );
    }
  }
  const ref = { schema: schemaOf(table), name: table.name };
  const target = quoteTable(ref);
  const alter = (clause: string): string => `ALTER TABLE ${target} ${clause}`;
  const q = quoteIdentifier;
  const statements: string[] = ['BEGIN TRANSACTION'];

  for (const key of diff.droppedKeys) {
    statements.push(alter(`DROP CONSTRAINT ${q(key.original ?? key.name)}`));
  }
  for (const index of diff.droppedIndexes) {
    const name = index.original ?? index.name;
    statements.push(
      background.constraintIndexes.includes(name)
        ? alter(`DROP CONSTRAINT ${q(name)}`)
        : `DROP INDEX ${q(name)} ON ${target}`,
    );
  }
  if (diff.primaryKey && before.columns.some((column) => column.primaryKey)) {
    statements.push(dropPrimaryKeySql(ref, background.primaryKeyName));
  }
  for (const column of diff.dropped) {
    const name = column.original ?? column.name;
    if (column.defaultValue.trim() !== '') {
      statements.push(dropDefaultSql(ref, name));
    }
    statements.push(alter(`DROP COLUMN ${q(name)}`));
  }
  for (const change of diff.changed) {
    const { before: old, after: next } = change;
    const name = next.name.trim();
    if (change.renamed) {
      const oldName = old.original ?? old.name;
      statements.push(
        `EXEC sp_rename ${renameTarget([ref.schema, ref.name, oldName])}, ${quoteString(name)}, N'COLUMN'`,
      );
    }
    // A default stands in the way of a new type; it is put back (as designed) after.
    const retype = change.type && old.defaultValue.trim() !== '';
    if (retype || (change.defaultValue && old.defaultValue.trim() !== '')) {
      statements.push(dropDefaultSql(ref, name));
    }
    if (change.type || change.nullable) {
      // ALTER COLUMN restates the whole column: type and nullability together.
      const nullable = next.nullable && !next.primaryKey;
      statements.push(
        alter(
          `ALTER COLUMN ${q(name)} ${composeType(next.type, next.length)} ${nullable ? 'NULL' : 'NOT NULL'}`,
        ),
      );
    }
    if ((retype || change.defaultValue) && next.defaultValue.trim() !== '') {
      statements.push(alter(`ADD DEFAULT ${next.defaultValue.trim()} FOR ${q(name)}`));
    }
  }
  for (const column of diff.added) {
    statements.push(alter(`ADD ${mssqlColumnSql(column)}`));
  }
  const keyColumns = after.columns.filter((column) => column.primaryKey).map((c) => c.id);
  if (diff.primaryKey && keyColumns.length > 0) {
    statements.push(alter(`ADD PRIMARY KEY ${columnList(after, keyColumns, q)}`));
  }
  for (const index of diff.addedIndexes) {
    statements.push(createIndexSql(after, index, q, target));
  }
  for (const key of diff.addedKeys) {
    const keyTarget = quoteTable({
      schema: key.targetSchema ?? ref.schema,
      name: key.targetTable.trim(),
    });
    statements.push(alter(`ADD ${foreignKeySql(after, key, q, keyTarget)}`));
  }
  if (diff.comment) {
    statements.push(...descriptionChange(ref, undefined, before.comment, after.comment));
  }
  for (const change of diff.changed.filter((c) => c.comment)) {
    statements.push(
      ...descriptionChange(
        ref,
        change.after.name.trim(),
        change.before.comment,
        change.after.comment,
      ),
    );
  }
  for (const column of diff.added.filter((c) => c.comment !== '')) {
    statements.push(describeSql(ref, column.name.trim(), column.comment));
  }
  if (diff.renamed) {
    statements.push(
      `EXEC sp_rename ${renameTarget([ref.schema, ref.name])}, ${quoteString(after.name.trim())}`,
    );
  }
  statements.push('COMMIT TRANSACTION');
  return {
    statements,
    notes: diff.order ? ['order-ignored'] : [],
    recovery: ['IF @@TRANCOUNT > 0 ROLLBACK TRANSACTION'],
  };
}

/** Adds, updates or drops a description, by what it was and what it is to be. */
function descriptionChange(
  table: { schema: string; name: string },
  column: string | undefined,
  was: string,
  will: string,
): string[] {
  if (was === '' && will === '') {
    return [];
  }
  if (was === '') {
    return [describeSql(table, column, will)];
  }
  if (will === '') {
    return [describeSql(table, column, '', 'sp_dropextendedproperty')];
  }
  return [describeSql(table, column, will, 'sp_updateextendedproperty')];
}
