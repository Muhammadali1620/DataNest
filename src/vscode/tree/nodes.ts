// The shape of the connections tree. Free of `vscode` so the structure and the
// identity rules are covered by unit tests (ARCHITECTURE.md §11).

import type {
  ColumnInfo,
  ObjectRef,
  ObjectScope,
  TableKind,
  TableRef,
} from '../../core/model/objects';

/** The view id the tree is registered under; `package.json` must declare the same. */
export const CONNECTIONS_VIEW_ID = 'datanest.connections';

/**
 * `contextValue` of every item kind. Menus in `package.json` match on these, so a
 * test can check that no menu refers to a value the tree never sets.
 */
export const TREE_CONTEXT = {
  connection: 'datanest.connection',
  connectionConnected: 'datanest.connection.connected',
  database: 'datanest.database',
  schema: 'datanest.schema',
  group: 'datanest.group',
  table: 'datanest.table',
  view: 'datanest.view',
  column: 'datanest.column',
  message: 'datanest.message',
} as const;

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

/**
 * The connection a node belongs to. Tree commands get the clicked node, while the
 * command palette passes a plain id (or nothing at all).
 */
export function connectionIdOf(target: TreeNode | string | undefined): string | undefined {
  if (typeof target === 'string') {
    return target === '' ? undefined : target;
  }
  if (target === undefined) {
    return undefined;
  }
  return 'connectionId' in target ? target.connectionId : undefined;
}

/** True for anything that looks like a tree node this extension produced. */
export function isTreeNode(value: unknown): value is TreeNode {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const { kind } = value as { kind?: unknown };
  return (
    kind === 'connection' ||
    kind === 'database' ||
    kind === 'schema' ||
    kind === 'group' ||
    kind === 'table' ||
    kind === 'column' ||
    kind === 'message'
  );
}

/** The name a "copy name" command puts on the clipboard. */
export function nameOf(node: TreeNode): string | undefined {
  switch (node.kind) {
    case 'database':
      return node.database;
    case 'schema':
      return node.schema;
    case 'table':
      return node.name;
    case 'column':
      return node.column.name;
    case 'connection':
    case 'group':
    case 'message':
      return undefined;
  }
}

/** The table a node points at, for "open table" and column lookups. */
export function tableRefOf(node: TableNode): TableRef {
  return { ...node.scope, name: node.name };
}

/** The object whose definition a node stands for; folders and columns have none. */
export function objectRefOf(node: TreeNode): ObjectRef | undefined {
  switch (node.kind) {
    case 'table':
      return { ...node.scope, kind: node.tableKind, name: node.name };
    case 'connection':
    case 'database':
    case 'schema':
    case 'group':
    case 'column':
    case 'message':
      return undefined;
  }
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
