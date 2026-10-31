// The SQL of a tree node that is not a table: what a double click on a column, index,
// foreign key, trigger or routine opens in an editor (V11.12). It reads what the
// server says now and renders it as a script; the builders live with the drivers.

import type { ColumnDetail, ColumnInfo, ForeignKey, IndexInfo } from '../core/model/objects';
import type { ObjectRef, TableRef } from '../core/model/objects';
import { columnSql, foreignKeySql, indexSql, triggerStatements } from '../drivers/common/node-sql';
import { browseSession } from './browse-session';
import type { ConnectionManager } from './connection-manager';
import { definitionDocument } from './object-definitions';

/** The nodes this module writes SQL for. */
export type NodeSqlTarget =
  | { readonly kind: 'column'; readonly table: TableRef; readonly column: ColumnInfo }
  | { readonly kind: 'index'; readonly table: TableRef; readonly index: IndexInfo }
  | { readonly kind: 'foreignKey'; readonly table: TableRef; readonly key: ForeignKey }
  | { readonly kind: 'object'; readonly object: ObjectRef };

/** The database whose session reads the node, and so the editor binds to. */
export function nodeSqlDatabase(target: NodeSqlTarget): string | undefined {
  return target.kind === 'object' ? target.object.database : target.table.database;
}

/** What the listing knows, when the table's full structure cannot be read. */
function detailOf(column: ColumnInfo): ColumnDetail {
  return {
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    ...(column.defaultValue === undefined ? {} : { defaultExpression: column.defaultValue }),
    autoIncrement: false,
    generated: false,
  };
}

export async function readNodeSql(
  manager: Pick<ConnectionManager, 'acquire' | 'driverOf'>,
  connectionId: string,
  target: NodeSqlTarget,
): Promise<string> {
  const driver = await manager.driverOf(connectionId);
  const session = await browseSession(manager, connectionId, nodeSqlDatabase(target));
  const { dialect } = driver;
  switch (target.kind) {
    case 'object': {
      const statements = await session.metadata.getDefinition(target.object);
      return definitionDocument(
        target.object.kind === 'trigger' ? triggerStatements(driver.id, statements) : statements,
        driver.id,
      );
    }
    case 'column': {
      // The full structure has the comment and the numbering; the listing is the fallback.
      const structure = await session.metadata.describeTable(target.table).catch(() => undefined);
      const detail =
        structure?.columns.find((column) => column.name === target.column.name) ??
        detailOf(target.column);
      return columnSql(driver.id, dialect, target.table, detail);
    }
    case 'index':
      return indexSql(driver.id, dialect, target.table, target.index);
    case 'foreignKey':
      return foreignKeySql(driver.id, dialect, target.table, target.key);
  }
}
