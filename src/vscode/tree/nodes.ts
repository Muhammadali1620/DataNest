// The shape of the connections tree. Free of `vscode` so the structure and the
// identity rules are covered by unit tests (ARCHITECTURE.md §11).

import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectRef,
  ObjectScope,
  RelationKind,
  TableKind,
  TableRef,
} from '../../core/model/objects';
import { type RedisKeyRef, redisKeyId } from '../../shared/redis-key';

/** The view id the tree is registered under; `package.json` must declare the same. */
export const CONNECTIONS_VIEW_ID = 'datanest.connections';

/**
 * `contextValue` of every item kind. Menus in `package.json` match on these, so a
 * test can check that no menu refers to a value the tree never sets.
 */
export const TREE_CONTEXT = {
  /** A folder of connections at the top of the tree. */
  connectionFolder: 'datanest.connectionFolder',
  connection: 'datanest.connection',
  connectionConnected: 'datanest.connection.connected',
  /** The connections of a workspace folder's `.vscode/datanest.json` (V4.7). */
  project: 'datanest.project',
  /** A connection from a project file: no user folders, other menus. */
  projectConnection: 'datanest.projectConnection',
  projectConnectionConnected: 'datanest.projectConnection.connected',
  /** Redis connections (V7.1) share the connection menus but none of the SQL ones. */
  redisConnection: 'datanest.redisConnection',
  redisConnectionConnected: 'datanest.redisConnection.connected',
  projectRedisConnection: 'datanest.projectRedisConnection',
  projectRedisConnectionConnected: 'datanest.projectRedisConnection.connected',
  /** A numbered Redis database. */
  redisDatabase: 'datanest.redisDatabase',
  /** A group of Redis keys sharing a prefix (V7.2). */
  redisFolder: 'datanest.redisFolder',
  redisKey: 'datanest.redisKey',
  /** "Load more keys" at the end of a database that SCAN has not walked yet. */
  redisMore: 'datanest.redisMore',
  database: 'datanest.database',
  schema: 'datanest.schema',
  group: 'datanest.group',
  /** The Tables folder, where a new table can be created. */
  tablesGroup: 'datanest.group.tables',
  /** The Views folder, which can be dumped as a whole. */
  viewsGroup: 'datanest.group.views',
  table: 'datanest.table',
  view: 'datanest.view',
  column: 'datanest.column',
  /** Indexes, Foreign Keys and Triggers inside a table. */
  folder: 'datanest.folder',
  function: 'datanest.function',
  procedure: 'datanest.procedure',
  trigger: 'datanest.trigger',
  sequence: 'datanest.sequence',
  event: 'datanest.event',
  index: 'datanest.index',
  foreignKey: 'datanest.foreignKey',
  message: 'datanest.message',
} as const;

/** Folders of a database or schema. */
export type ObjectGroup = 'tables' | 'views' | 'functions' | 'procedures' | 'sequences' | 'events';

/** The folder each listed kind lives in at the scope level (triggers live in tables). */
export const GROUP_OF_KIND: Readonly<Record<Exclude<ListedObjectKind, 'trigger'>, ObjectFolder>> = {
  function: 'functions',
  procedure: 'procedures',
  sequence: 'sequences',
  event: 'events',
};

/** Scope folders that hold listed objects rather than tables and views. */
export type ObjectFolder = Exclude<ObjectGroup, 'tables' | 'views'>;

/** The listed kind each object folder holds. */
export const KIND_OF_GROUP: Readonly<Record<ObjectFolder, ListedObjectKind>> = {
  functions: 'function',
  procedures: 'procedure',
  sequences: 'sequence',
  events: 'event',
};

/** Folders inside a table, after its columns. */
export type TableFolder = 'indexes' | 'foreignKeys' | 'triggers';

/** A folder the user keeps connections in; it has no connection of its own. */
export interface ConnectionFolderNode {
  readonly kind: 'connectionFolder';
  readonly folder: string;
}

/** The project file of one workspace folder, holding the connections it shares. */
export interface ProjectNode {
  readonly kind: 'project';
  /** The folder's key (`ProjectFolder.key`). */
  readonly key: string;
  readonly name: string;
}

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

/** The "Tables", "Views", "Functions", … folders inside a scope. */
export interface GroupNode {
  readonly kind: 'group';
  readonly group: ObjectGroup;
  readonly connectionId: string;
  readonly scope: ObjectScope;
}

export interface TableNode {
  readonly kind: 'table';
  readonly connectionId: string;
  readonly scope: ObjectScope;
  readonly name: string;
  readonly tableKind: TableKind;
  /** A PostgreSQL materialized view. */
  readonly materialized?: boolean;
}

export interface ColumnNode {
  readonly kind: 'column';
  readonly connectionId: string;
  readonly table: TableRef;
  readonly column: ColumnInfo;
}

/** "Indexes", "Foreign Keys" or "Triggers" of one table. */
export interface FolderNode {
  readonly kind: 'folder';
  readonly folder: TableFolder;
  readonly connectionId: string;
  readonly table: TableRef;
}

/** A function, procedure, trigger, sequence or event. */
export interface ObjectNode {
  readonly kind: 'object';
  readonly connectionId: string;
  readonly object: ObjectRef & { readonly kind: ListedObjectKind };
}

export interface IndexNode {
  readonly kind: 'index';
  readonly connectionId: string;
  readonly table: TableRef;
  readonly index: IndexInfo;
}

export interface ForeignKeyNode {
  readonly kind: 'foreignKey';
  readonly connectionId: string;
  readonly table: TableRef;
  readonly key: ForeignKey;
}

/** A numbered database of a Redis connection (V7.1). */
export interface RedisDatabaseNode {
  readonly kind: 'redisDatabase';
  readonly connectionId: string;
  readonly database: number;
  readonly keys: number;
}

/** Keys of a Redis database that share a prefix: `user:` holds `user:1`, `user:2` (V7.2). */
export interface RedisFolderNode {
  readonly kind: 'redisFolder';
  readonly connectionId: string;
  readonly database: number;
  /** Segments from the top, this folder's last. */
  readonly path: readonly string[];
  /** The prefix with its separator, e.g. `user:`: what "copy name" copies. */
  readonly prefix: string;
  /** Loaded keys below it. */
  readonly count: number;
}

export interface RedisKeyNode {
  readonly kind: 'redisKey';
  readonly connectionId: string;
  readonly database: number;
  readonly key: RedisKeyRef;
  /** The last segment, shown inside its folder. */
  readonly name: string;
  /** `string`, `hash`, …; absent when the server did not say. */
  readonly keyType?: string;
}

/** The leaf after the keys of a database that SCAN has not walked to the end. */
export interface RedisMoreNode {
  readonly kind: 'redisMore';
  readonly connectionId: string;
  readonly database: number;
  /** Keys loaded so far. */
  readonly loaded: number;
}

/** A leaf that explains something instead of listing objects: an error or "empty". */
export interface MessageNode {
  readonly kind: 'message';
  readonly text: string;
  /** Set when the message belongs to one connection, so refresh can target it. */
  readonly connectionId?: string;
  /** Marks a failure, so the item can be shown differently. */
  readonly failed?: boolean;
  /** Set on the "empty folder" leaf, so connections dropped on it land in the folder. */
  readonly folder?: string;
}

export type TreeNode =
  | ProjectNode
  | ConnectionFolderNode
  | ConnectionNode
  | DatabaseNode
  | SchemaNode
  | GroupNode
  | TableNode
  | ColumnNode
  | FolderNode
  | ObjectNode
  | IndexNode
  | ForeignKeyNode
  | RedisDatabaseNode
  | RedisFolderNode
  | RedisKeyNode
  | RedisMoreNode
  | MessageNode;

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
    case 'folder':
    case 'index':
    case 'foreignKey':
      return scopeOfRef(node.table);
    case 'object':
      return scopeOfRef(node.object);
    case 'project':
    case 'connectionFolder':
    case 'connection':
    case 'redisDatabase':
    case 'redisFolder':
    case 'redisKey':
    case 'redisMore':
    case 'message':
      return {};
  }
}

function scopeOfRef(table: ObjectScope): ObjectScope {
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
    case 'project':
      return join(['project', node.key]);
    case 'connectionFolder':
      return join(['connectionFolder', node.folder]);
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
    case 'folder':
      return join([
        'folder',
        node.connectionId,
        scopeKey(scopeOfRef(node.table)),
        node.table.name,
        node.folder,
      ]);
    case 'object':
      // Overloads share a name; the signature tells them apart. Triggers are
      // unique per table only, in some databases.
      return join([
        'object',
        node.connectionId,
        scopeKey(scopeOfRef(node.object)),
        node.object.kind,
        node.object.table ?? '',
        node.object.name,
        node.object.signature ?? '',
      ]);
    case 'index':
      return join([
        'index',
        node.connectionId,
        scopeKey(scopeOfRef(node.table)),
        node.table.name,
        node.index.name,
      ]);
    case 'foreignKey':
      return join([
        'foreignKey',
        node.connectionId,
        scopeKey(scopeOfRef(node.table)),
        node.table.name,
        node.key.name,
      ]);
    case 'redisDatabase':
      return join(['redisDatabase', node.connectionId, String(node.database)]);
    case 'redisFolder':
      return join(['redisFolder', node.connectionId, String(node.database), ...node.path]);
    case 'redisKey':
      return join(['redisKey', node.connectionId, String(node.database), redisKeyId(node.key)]);
    case 'redisMore':
      return join(['redisMore', node.connectionId, String(node.database)]);
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
    kind === 'project' ||
    kind === 'connectionFolder' ||
    kind === 'connection' ||
    kind === 'database' ||
    kind === 'schema' ||
    kind === 'group' ||
    kind === 'table' ||
    kind === 'column' ||
    kind === 'folder' ||
    kind === 'object' ||
    kind === 'index' ||
    kind === 'foreignKey' ||
    kind === 'redisDatabase' ||
    kind === 'redisFolder' ||
    kind === 'redisKey' ||
    kind === 'redisMore' ||
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
    case 'object':
      return node.object.name;
    case 'index':
      return node.index.name;
    case 'foreignKey':
      return node.key.name;
    case 'connectionFolder':
      return node.folder;
    case 'redisKey':
      return node.key.text;
    case 'redisFolder':
      return node.prefix;
    case 'project':
    case 'connection':
    case 'group':
    case 'folder':
    case 'redisDatabase':
    case 'redisMore':
    case 'message':
      return undefined;
  }
}

/** What DDL calls the relation of a table node. */
export function relationKindOf(node: TableNode): RelationKind {
  if (node.tableKind === 'table') {
    return 'table';
  }
  return node.materialized === true ? 'materialized-view' : 'view';
}

/** The table a node points at, for "open table" and column lookups. */
export function tableRefOf(node: TableNode): TableRef {
  return { ...node.scope, name: node.name };
}

/** The object whose definition a node stands for; folders and columns have none. */
export function objectRefOf(node: TreeNode): ObjectRef | undefined {
  switch (node.kind) {
    case 'table':
      return {
        ...node.scope,
        kind: node.tableKind,
        name: node.name,
        ...(node.materialized === true ? { materialized: true } : {}),
      };
    case 'object':
      return node.object;
    case 'project':
    case 'connectionFolder':
    case 'connection':
    case 'database':
    case 'schema':
    case 'group':
    case 'column':
    case 'folder':
    case 'index':
    case 'foreignKey':
    case 'redisDatabase':
    case 'redisFolder':
    case 'redisKey':
    case 'redisMore':
    case 'message':
      return undefined;
  }
}

/** The context value of a connection item, which the menus of package.json match. */
export function connectionContext(options: {
  readonly project: boolean;
  readonly connected: boolean;
  readonly redis: boolean;
}): string {
  const { project, connected, redis } = options;
  if (redis) {
    return project
      ? connected
        ? TREE_CONTEXT.projectRedisConnectionConnected
        : TREE_CONTEXT.projectRedisConnection
      : connected
        ? TREE_CONTEXT.redisConnectionConnected
        : TREE_CONTEXT.redisConnection;
  }
  return project
    ? connected
      ? TREE_CONTEXT.projectConnectionConnected
      : TREE_CONTEXT.projectConnection
    : connected
      ? TREE_CONTEXT.connectionConnected
      : TREE_CONTEXT.connection;
}
