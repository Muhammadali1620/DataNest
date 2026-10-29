// Pieces of SQL Server DDL that creating and altering a table share.

import type { ForeignKeyDesign, TableDesign } from '../../shared/table-design';
import { columnSql } from '../common/design-sql';
import { quoteIdentifier, quoteString } from './quote';

/** SQL Server has no RESTRICT; NO ACTION refuses the same changes. */
export function withoutRestrict(key: ForeignKeyDesign): ForeignKeyDesign {
  return {
    ...key,
    onDelete: key.onDelete === 'RESTRICT' ? 'NO ACTION' : key.onDelete,
    onUpdate: key.onUpdate === 'RESTRICT' ? 'NO ACTION' : key.onUpdate,
  };
}

/** `[col] type IDENTITY(1, 1) NOT NULL DEFAULT …`: the clause order SQL Server expects. */
export function mssqlColumnSql(column: TableDesign['columns'][number]): string {
  return columnSql(column, {
    quote: quoteIdentifier,
    autoIncrement: () => 'IDENTITY(1, 1)',
    trailer: () => '',
  });
}

/** sp_rename's first argument: the object as a string, its parts quoted. */
export function renameTarget(parts: readonly string[]): string {
  return quoteString(parts.map(quoteIdentifier).join('.'));
}
