// "Generate SELECT / INSERT / UPDATE / DELETE" on a table of the tree: the columns
// come from the server, the statement opens in a new editor as a snippet.

import type { ColumnInfo, TableRef, TableStructure } from '../../core/model/objects';
import type { Dialect, MetadataReader } from '../../drivers/driver';
import { sqlTemplate, type TemplateColumn, type TemplateKind } from '../../services/sql-templates';
import type { DocumentBinding } from '../editor/document-bindings';
import { isTreeNode, tableRefOf } from './nodes';
import type { CommandTarget } from './tree-commands';

export interface TemplateCommandDeps {
  readonly dialectOf: (connectionId: string) => Promise<Dialect>;
  readonly metadataOf: (
    connectionId: string,
    database: string | undefined,
  ) => Promise<Pick<MetadataReader, 'describeTable' | 'listColumns'>>;
  /** Opens a new editor on the connection and inserts the snippet into it. */
  readonly openSnippet: (binding: DocumentBinding, snippet: string) => Promise<unknown>;
}

/** The columns of a table, or of a view, which has no structure of its own to read. */
export async function templateColumns(
  metadata: Pick<MetadataReader, 'describeTable' | 'listColumns'>,
  table: TableRef,
): Promise<TemplateColumn[]> {
  let structure: TableStructure | undefined;
  try {
    structure = await metadata.describeTable(table);
  } catch {
    structure = undefined;
  }
  if (structure !== undefined) {
    const key = structure.primaryKey;
    return structure.columns.map((column) => ({
      name: column.name,
      primaryKey: key.includes(column.name),
      generated: column.autoIncrement || column.generated,
    }));
  }
  const columns: ColumnInfo[] = await metadata.listColumns(table);
  return columns.map((column) => ({
    name: column.name,
    primaryKey: column.primaryKey,
    generated: false,
  }));
}

export function templateCommandHandlers(
  deps: TemplateCommandDeps,
): (kind: TemplateKind) => (target?: CommandTarget) => Promise<void> {
  return (kind) => async (target) => {
    if (!isTreeNode(target) || target.kind !== 'table') {
      return;
    }
    // A view takes only SELECT from here; what else it accepts depends on its query.
    if (target.tableKind === 'view' && kind !== 'select') {
      return;
    }
    const table = tableRefOf(target);
    const [dialect, metadata] = await Promise.all([
      deps.dialectOf(target.connectionId),
      deps.metadataOf(target.connectionId, table.database),
    ]);
    const columns = await templateColumns(metadata, table);
    await deps.openSnippet(
      table.database === undefined
        ? { connectionId: target.connectionId }
        : { connectionId: target.connectionId, database: table.database },
      sqlTemplate(kind, table, columns, dialect),
    );
  };
}
