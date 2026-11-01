// Favorites of the Connections view (V13.2): the nodes the user starred, kept as small
// descriptors (never as nodes, whose sizes and counts go stale) and shown in a group at
// the top of the tree. Free of `vscode`, so the rules are unit-tested.

import { type Disposable, toDisposable } from '../../core/disposable';
import type { TableKind } from '../../core/model/objects';
import type { KeyValueState } from '../../services/connection-store';
import { isPlainObject } from '../../shared/schema';
import { TREE_CONTEXT, type TreeNode, nodeId } from './nodes';

export const FAVORITES_STATE_KEY = 'favorites';
export const MAX_FAVORITES = 500;

/** What a starred node is, enough to find it again. */
export type FavoriteRef =
  | { readonly kind: 'connection'; readonly connectionId: string }
  | { readonly kind: 'database'; readonly connectionId: string; readonly database: string }
  | {
      readonly kind: 'schema';
      readonly connectionId: string;
      readonly database?: string;
      readonly schema: string;
    }
  | {
      readonly kind: 'table';
      readonly connectionId: string;
      readonly database?: string;
      readonly schema?: string;
      readonly name: string;
      readonly tableKind: TableKind;
      readonly materialized?: boolean;
    }
  | { readonly kind: 'redisDatabase'; readonly connectionId: string; readonly database: number }
  | { readonly kind: 'mongoDatabase'; readonly connectionId: string; readonly database: string }
  | {
      readonly kind: 'mongoCollection';
      readonly connectionId: string;
      readonly database: string;
      readonly collection: string;
      readonly collectionType: 'collection' | 'view' | 'timeseries';
    }
  | { readonly kind: 'elasticIndex'; readonly connectionId: string; readonly name: string };

/**
 * A starred node wears its usual context value plus this suffix, so the menus can offer
 * "Remove from Favorites" instead of "Add to Favorites"; every menu entry that matches
 * such a node by context value matches the starred one too (package.json, checked by a test).
 */
export const STARRED_SUFFIX = '.starred';

/** The context values of the nodes that may be starred, without the suffix. */
export const FAVORITABLE_CONTEXTS: readonly string[] = [
  TREE_CONTEXT.connection,
  TREE_CONTEXT.connectionConnected,
  TREE_CONTEXT.connectionDisabled,
  TREE_CONTEXT.projectConnection,
  TREE_CONTEXT.projectConnectionConnected,
  TREE_CONTEXT.redisConnection,
  TREE_CONTEXT.redisConnectionConnected,
  TREE_CONTEXT.projectRedisConnection,
  TREE_CONTEXT.projectRedisConnectionConnected,
  TREE_CONTEXT.mongoConnection,
  TREE_CONTEXT.mongoConnectionConnected,
  TREE_CONTEXT.projectMongoConnection,
  TREE_CONTEXT.projectMongoConnectionConnected,
  TREE_CONTEXT.elasticConnection,
  TREE_CONTEXT.elasticConnectionConnected,
  TREE_CONTEXT.projectElasticConnection,
  TREE_CONTEXT.projectElasticConnectionConnected,
  TREE_CONTEXT.database,
  TREE_CONTEXT.schema,
  TREE_CONTEXT.table,
  TREE_CONTEXT.view,
  TREE_CONTEXT.redisDatabase,
  TREE_CONTEXT.mongoDatabase,
  TREE_CONTEXT.mongoCollection,
  TREE_CONTEXT.mongoView,
  TREE_CONTEXT.elasticIndex,
];

/** The context value of a node, marked as starred. */
export function starredContext(contextValue: string | undefined): string | undefined {
  return contextValue === undefined || contextValue.endsWith(STARRED_SUFFIX)
    ? contextValue
    : `${contextValue}${STARRED_SUFFIX}`;
}

/** The element at the top of the tree that holds the starred nodes. */
export interface FavoritesRootNode {
  readonly kind: 'favorites';
}

/**
 * A node shown inside the Favorites group, or below one. It only stands in for `target`:
 * commands get the target, and `via` (the id of the parent entry) keeps ids unique when
 * the same node is also in the ordinary tree.
 */
export interface FavoriteNode {
  readonly kind: 'favorite';
  readonly target: TreeNode;
  readonly via: string;
}

/** Everything the Connections view can hold. */
export type TreeElement = TreeNode | FavoritesRootNode | FavoriteNode;

export function isFavoriteNode(value: unknown): value is FavoriteNode {
  return isPlainObject(value) && value.kind === 'favorite' && isPlainObject(value.target);
}

/** Gives commands the real node: the target of an entry, and the targets in lists. */
export function unwrapFavorite(value: unknown): unknown {
  if (isFavoriteNode(value)) {
    return value.target;
  }
  return Array.isArray(value) ? value.map(unwrapFavorite) : value;
}

export function favoriteNodeId(node: FavoriteNode): string {
  return `favorite|${node.via}|${nodeId(node.target)}`;
}

/** The descriptor of a node the user may star; other nodes have none. */
export function refOf(node: TreeNode): FavoriteRef | undefined {
  switch (node.kind) {
    case 'connection':
      return { kind: 'connection', connectionId: node.connectionId };
    case 'database':
      return { kind: 'database', connectionId: node.connectionId, database: node.database };
    case 'schema':
      return {
        kind: 'schema',
        connectionId: node.connectionId,
        ...(node.database === undefined ? {} : { database: node.database }),
        schema: node.schema,
      };
    case 'table':
      return {
        kind: 'table',
        connectionId: node.connectionId,
        ...(node.scope.database === undefined ? {} : { database: node.scope.database }),
        ...(node.scope.schema === undefined ? {} : { schema: node.scope.schema }),
        name: node.name,
        tableKind: node.tableKind,
        ...(node.materialized === true ? { materialized: true } : {}),
      };
    case 'redisDatabase':
      return { kind: 'redisDatabase', connectionId: node.connectionId, database: node.database };
    case 'mongoDatabase':
      return { kind: 'mongoDatabase', connectionId: node.connectionId, database: node.database };
    case 'mongoCollection':
      return {
        kind: 'mongoCollection',
        connectionId: node.connectionId,
        database: node.database,
        collection: node.collection,
        collectionType: node.collectionType,
      };
    case 'elasticIndex':
      return { kind: 'elasticIndex', connectionId: node.connectionId, name: node.index.name };
    case 'project':
    case 'connectionFolder':
    case 'group':
    case 'column':
    case 'folder':
    case 'object':
    case 'index':
    case 'foreignKey':
    case 'queryFolder':
    case 'savedQuery':
    case 'security':
    case 'securityGroup':
    case 'account':
    case 'redisFolder':
    case 'redisKey':
    case 'redisMore':
    case 'mongoIndex':
    case 'elasticField':
    case 'etcdFolder':
    case 'etcdKey':
    case 'etcdMore':
    case 'message':
      return undefined;
  }
}

/** The node a descriptor stands for. Counts and sizes are unknown here and left out. */
export function nodeOfRef(ref: FavoriteRef): TreeNode {
  switch (ref.kind) {
    case 'connection':
      return { kind: 'connection', connectionId: ref.connectionId };
    case 'database':
      return { kind: 'database', connectionId: ref.connectionId, database: ref.database };
    case 'schema':
      return {
        kind: 'schema',
        connectionId: ref.connectionId,
        ...(ref.database === undefined ? {} : { database: ref.database }),
        schema: ref.schema,
      };
    case 'table':
      return {
        kind: 'table',
        connectionId: ref.connectionId,
        scope: {
          ...(ref.database === undefined ? {} : { database: ref.database }),
          ...(ref.schema === undefined ? {} : { schema: ref.schema }),
        },
        name: ref.name,
        tableKind: ref.tableKind,
        ...(ref.materialized === true ? { materialized: true } : {}),
      };
    case 'redisDatabase':
      return {
        kind: 'redisDatabase',
        connectionId: ref.connectionId,
        database: ref.database,
        keys: 0,
      };
    case 'mongoDatabase':
      return { kind: 'mongoDatabase', connectionId: ref.connectionId, database: ref.database };
    case 'mongoCollection':
      return {
        kind: 'mongoCollection',
        connectionId: ref.connectionId,
        database: ref.database,
        collection: ref.collection,
        collectionType: ref.collectionType,
      };
    case 'elasticIndex':
      return {
        kind: 'elasticIndex',
        connectionId: ref.connectionId,
        index: { name: ref.name, status: 'open', hidden: false },
      };
  }
}

/** Two descriptors of one node have the same key. */
export function refKey(ref: FavoriteRef): string {
  return nodeId(nodeOfRef(ref));
}

const COLLECTION_TYPES: readonly unknown[] = ['collection', 'view', 'timeseries'];

function text(value: unknown): value is string {
  return typeof value === 'string' && value !== '' && value.length <= 1000;
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || text(value);
}

/** A descriptor from saved state, or `undefined` for anything that is not one. */
export function parseRef(value: unknown): FavoriteRef | undefined {
  if (!isPlainObject(value) || !text(value.connectionId)) {
    return undefined;
  }
  const connectionId = value.connectionId;
  const { database, schema, name, collection } = value;
  switch (value.kind) {
    case 'connection':
      return { kind: 'connection', connectionId };
    case 'database':
    case 'mongoDatabase':
      return text(database) ? { kind: value.kind, connectionId, database } : undefined;
    case 'schema':
      return text(schema) && optionalText(database)
        ? {
            kind: 'schema',
            connectionId,
            ...(database === undefined ? {} : { database }),
            schema,
          }
        : undefined;
    case 'table':
      return text(name) &&
        (value.tableKind === 'table' || value.tableKind === 'view') &&
        optionalText(database) &&
        optionalText(schema)
        ? {
            kind: 'table',
            connectionId,
            ...(database === undefined ? {} : { database }),
            ...(schema === undefined ? {} : { schema }),
            name,
            tableKind: value.tableKind,
            ...(value.materialized === true ? { materialized: true } : {}),
          }
        : undefined;
    case 'redisDatabase':
      return typeof database === 'number' && Number.isInteger(database)
        ? { kind: 'redisDatabase', connectionId, database }
        : undefined;
    case 'mongoCollection':
      return text(database) && text(collection) && COLLECTION_TYPES.includes(value.collectionType)
        ? {
            kind: 'mongoCollection',
            connectionId,
            database,
            collection,
            collectionType: value.collectionType as 'collection' | 'view' | 'timeseries',
          }
        : undefined;
    case 'elasticIndex':
      return text(name) ? { kind: 'elasticIndex', connectionId, name } : undefined;
    default:
      return undefined;
  }
}

/** The starred nodes, in the order they were starred. Kept in the editor's global state. */
export class FavoritesStore {
  private items: FavoriteRef[];
  private readonly listeners = new Set<() => void>();

  constructor(private readonly state: KeyValueState) {
    this.items = FavoritesStore.read(state.get(FAVORITES_STATE_KEY));
  }

  private static read(raw: unknown): FavoriteRef[] {
    const list = isPlainObject(raw) && Array.isArray(raw.items) ? (raw.items as unknown[]) : [];
    const seen = new Set<string>();
    const refs: FavoriteRef[] = [];
    for (const entry of list) {
      const ref = parseRef(entry);
      if (ref !== undefined && !seen.has(refKey(ref)) && refs.length < MAX_FAVORITES) {
        seen.add(refKey(ref));
        refs.push(ref);
      }
    }
    return refs;
  }

  list(): readonly FavoriteRef[] {
    return this.items;
  }

  has(node: TreeNode): boolean {
    const ref = refOf(node);
    return ref !== undefined && this.items.some((item) => refKey(item) === refKey(ref));
  }

  /**
   * Stars the node, or takes the star off. Returns the new state of the star: `true` when
   * the node is a favorite now; `undefined` for a node that cannot be starred, or when
   * the list is full.
   */
  async toggle(node: TreeNode): Promise<boolean | undefined> {
    const ref = refOf(node);
    if (ref === undefined) {
      return undefined;
    }
    const key = refKey(ref);
    const present = this.items.some((item) => refKey(item) === key);
    if (present) {
      await this.save(this.items.filter((item) => refKey(item) !== key));
      return false;
    }
    if (this.items.length >= MAX_FAVORITES) {
      return undefined;
    }
    await this.save([...this.items, ref]);
    return true;
  }

  /** Forgets the stars of connections that are gone. */
  async retainConnections(known: ReadonlySet<string>): Promise<void> {
    const kept = this.items.filter((item) => known.has(item.connectionId));
    if (kept.length !== this.items.length) {
      await this.save(kept);
    }
  }

  onDidChange(listener: () => void): Disposable {
    this.listeners.add(listener);
    return toDisposable(() => this.listeners.delete(listener));
  }

  private async save(items: FavoriteRef[]): Promise<void> {
    await this.state.update(FAVORITES_STATE_KEY, { version: 1, items });
    this.items = items;
    for (const listener of [...this.listeners]) {
      listener();
    }
  }
}
