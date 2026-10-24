// The shape of the connections tree. Free of `vscode` so the structure and the
// identity rules are covered by unit tests (ARCHITECTURE.md §11).

import type { ColumnInfo, ObjectScope, TableKind, TableRef } from '../../core/model/objects';

export type TableGroup = 'tables' | 'views';

export interface ConnectionNode {
  readonly kind: 'connection';
  readonly connectionId: string;
}

export interface DatabaseNode {
  readonly kind: 'database';
  readonly connectionId: string;
  readonly database: string;
}

export interface SchemaNode {
  readonly kind: 'schema';
  readonly connectionId: string;
  readonly database?: string;
  readonly schema: string;
}

/** The "Tables" / "Views" folders inside a scope. */
export interface GroupNode {
  readonly kind: 'group';
  readonly group: TableGroup;
  readonly connectionId: string;
  readonly scope: ObjectScope;
}

export interface TableNode {
  readonly kind: 'table';
  readonly connectionId: string;
  readonly scope: ObjectScope;
  readonly name: string;
  readonly tableKind: TableKind;
}

export interface ColumnNode {
  readonly kind: 'column';
  readonly connectionId: string;
  readonly table: TableRef;
  readonly column: ColumnInfo;
}

/** A leaf that explains something instead of listing objects: an error or "empty". */
export interface MessageNode {
  readonly kind: 'message';
  readonly text: string;
  /** Set when the message belongs to one connection, so refresh can target it. */
  readonly connectionId?: string;
  /** Marks a failure, so the item can be shown differently. */
  readonly failed?: boolean;
}

export type TreeNode =
  ConnectionNode | DatabaseNode | SchemaNode | GroupNode | TableNode | ColumnNode | MessageNode;

/** Where in the database a node lives; the root scope is empty. */
export function scopeOf(node: TreeNode): ObjectScope {
  switch (node.kind) {
    case 'database':
      return { database: node.database };
    case 'schema':
      return {
        ...(node.database === undefined ? {} : { database: node.database }),
        schema: node.schema,
      };
    case 'group':
    case 'table':
      return node.scope;
    case 'column':
      return scopeOfRef(node.table);
    case 'connection':
    case 'message':
      return {};
  }
}

function scopeOfRef(table: TableRef): ObjectScope {
  return {
    ...(table.database === undefined ? {} : { database: table.database }),
    ...(table.schema === undefined ? {} : { schema: table.schema }),
  };
}

function scopeKey(scope: ObjectScope): string {
  return `${scope.database ?? ''}/${scope.schema ?? ''}`;
}

/**
 * A stable id per node, used by the editor to keep expanded state and by refresh.
 * Parts are escaped so a name containing a separator cannot collide with another node.
 */
export function nodeId(node: TreeNode): string {
  switch (node.kind) {
    case 'connection':
      return join(['connection', node.connectionId]);
    case 'database':
      return join(['database', node.connectionId, node.database]);
    case 'schema':
      return join(['schema', node.connectionId, node.database ?? '', node.schema]);
    case 'group':
      return join(['group', node.connectionId, scopeKey(node.scope), node.group]);
    case 'table':
      return join(['table', node.connectionId, scopeKey(node.scope), node.name]);
    case 'column':
      return join([
        'column',
        node.connectionId,
        scopeKey(scopeOfRef(node.table)),
        node.table.name,
        node.column.name,
      ]);
    case 'message':
      return join(['message', node.connectionId ?? '', node.text]);
  }
}

function join(parts: readonly string[]): string {
  return parts.map((part) => part.replaceAll('\\', '\\\\').replaceAll(':', '\\:')).join(':');
}

/** The table a node points at, for "open table" and column lookups. */
export function tableRefOf(node: TableNode): TableRef {
  return { ...node.scope, name: node.name };
}

/** One-line summary of a column: type, key and nullability. */
export function describeColumn(column: ColumnInfo): string {
  const parts = [column.dataType];
  if (column.primaryKey) {
    parts.push('PK');
  }
  if (!column.nullable) {
    parts.push('NOT NULL');
  }
  if (column.defaultValue !== undefined) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }
  return parts.join(', ');
}
