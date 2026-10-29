// What MongoDB nodes of the tree contain (V7.5): a connection's databases, a database's
// collections and views, a collection's indexes. Free of `vscode`, like TreeModel, which
// hands these nodes over.

import type { MongoSession } from '../../drivers/mongo-driver';
import { ConnectionManager } from '../../services/connection-manager';
import {
  collectionMarks,
  listMongoCollections,
  listMongoDatabases,
  listMongoIndexes,
  MONGO_SYSTEM_DATABASES,
} from '../../services/mongodb/catalog';
import type { ConnectionConfig } from '../../shared/connection';
import { filterNames } from '../../shared/name-filter';
import type { MongoCollectionNode, MongoDatabaseNode, TreeNode } from './nodes';

export interface MongoTreeTexts {
  readonly noDatabases: string;
  readonly noCollections: string;
  readonly noIndexes: string;
  readonly hiddenByFilter?: (count: number) => string;
}

export interface MongoTreeDeps {
  readonly manager: Pick<ConnectionManager, 'acquireMongo'>;
  readonly showSystemObjects: () => boolean;
  readonly texts: MongoTreeTexts;
}

/** The tree's session of a MongoDB connection: one client sees every database. */
export async function mongoTreeSession(
  manager: Pick<ConnectionManager, 'acquireMongo'>,
  connectionId: string,
): Promise<MongoSession> {
  return await manager.acquireMongo(ConnectionManager.treeOwner(connectionId), { connectionId });
}

export async function mongoDatabaseChildren(
  deps: MongoTreeDeps,
  config: ConnectionConfig,
): Promise<TreeNode[]> {
  const connectionId = config.id;
  const session = await mongoTreeSession(deps.manager, connectionId);
  const all = await listMongoDatabases(session, config.database);
  const visible = deps.showSystemObjects()
    ? all
    : all.filter((database) => !MONGO_SYSTEM_DATABASES.includes(database.name));
  const names = new Set(
    filterNames(
      visible.map((database) => database.name),
      config.filter?.databases ?? [],
    ),
  );
  const nodes = visible
    .filter((database) => names.has(database.name))
    .map((database): MongoDatabaseNode => ({
      kind: 'mongoDatabase',
      connectionId,
      database: database.name,
      ...(database.sizeOnDisk === undefined ? {} : { sizeOnDisk: database.sizeOnDisk }),
    }));
  const hidden = visible.length - nodes.length;
  const hiddenLeaf: TreeNode[] =
    hidden > 0 && deps.texts.hiddenByFilter !== undefined
      ? [{ kind: 'message', text: deps.texts.hiddenByFilter(hidden), connectionId }]
      : [];
  if (nodes.length === 0 && hiddenLeaf.length === 0) {
    return [{ kind: 'message', text: deps.texts.noDatabases, connectionId }];
  }
  return [...nodes, ...hiddenLeaf];
}

export async function mongoCollectionChildren(
  deps: MongoTreeDeps,
  connectionId: string,
  database: string,
): Promise<TreeNode[]> {
  const session = await mongoTreeSession(deps.manager, connectionId);
  const listing = await listMongoCollections(session, database, deps.showSystemObjects());
  const nodes = [...listing.collections, ...listing.views].map((info): MongoCollectionNode => {
    const marks = collectionMarks(info);
    return {
      kind: 'mongoCollection',
      connectionId,
      database,
      collection: info.name,
      collectionType: info.type,
      ...(marks.capped ? { capped: true } : {}),
      ...(marks.viewOn === undefined ? {} : { viewOn: marks.viewOn }),
      ...(marks.validated ? { validated: true } : {}),
    };
  });
  return nodes.length === 0
    ? [{ kind: 'message', text: deps.texts.noCollections, connectionId }]
    : nodes;
}

export async function mongoIndexChildren(
  deps: MongoTreeDeps,
  node: MongoCollectionNode,
): Promise<TreeNode[]> {
  const { connectionId, database, collection } = node;
  const session = await mongoTreeSession(deps.manager, connectionId);
  const indexes = await listMongoIndexes(session, database, collection);
  return indexes.length === 0
    ? [{ kind: 'message', text: deps.texts.noIndexes, connectionId }]
    : indexes.map((index): TreeNode => ({
        kind: 'mongoIndex',
        connectionId,
        database,
        collection,
        index,
      }));
}
