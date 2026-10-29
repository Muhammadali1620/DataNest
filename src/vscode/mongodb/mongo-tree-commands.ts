// Commands on the structure of a MongoDB server from the tree (V7.5): new and dropped
// databases, collections and indexes, a renamed collection. The editor bits arrive
// through the deps, so the behaviour is covered by unit tests; the questions themselves
// live in mongo-questions.ts.

import { DbError } from '../../core/errors';
import type { MongoDocument } from '../../core/mongo/value';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import {
  collectionNameProblem,
  createCollection,
  createDatabase,
  createIndex,
  databaseNameProblem,
  dropCollection,
  dropDatabase,
  dropIndex,
  type NewCollection,
  renameCollection,
} from '../../services/mongodb/schema-edits';
import { isTreeNode, type TreeNode } from '../tree/nodes';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';
import { mongoTreeSession } from '../tree/mongo-tree';

/** One line of text the user types; `check` explains what is wrong, or returns undefined. */
export interface TextQuestion {
  readonly title: string;
  readonly prompt: string;
  readonly value?: string;
  readonly placeHolder?: string;
  readonly check?: (text: string) => string | undefined;
}

export interface MongoTreeTexts {
  readonly newDatabase: string;
  readonly databaseName: string;
  readonly firstCollection: string;
  readonly renameCollection: string;
  newName(current: string): string;
  dropDatabase(name: string): string;
  /** Asks to type the database name back. */
  typeToDrop(name: string): string;
  readonly typeExactly: string;
  dropCollection(name: string, view: boolean): string;
  dropIndex(name: string, collection: string): string;
  readonly dropAction: string;
  productionDetail(connection: string): string;
  /** The button of the production question. */
  readonly changeAction: string;
  readonly readOnly: string;
  readonly noMongo: string;
  readonly renameView: string;
}

export interface MongoTreeCommandDeps {
  readonly manager: Pick<ConnectionManager, 'acquireMongo'>;
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly tree: RefreshableTree;
  /** Picks one of the MongoDB connections, for a command run from the palette. */
  readonly pickConnection: (ids: readonly string[]) => Promise<string | undefined>;
  readonly askText: (question: TextQuestion) => Promise<string | undefined>;
  /** Asks for the name and kind of a new collection. */
  readonly askNewCollection: (
    database: string,
  ) => Promise<{ readonly name: string; readonly options: NewCollection } | undefined>;
  /** Asks for the keys and options of a new index. */
  readonly askIndex: (
    collection: string,
  ) => Promise<{ readonly keys: MongoDocument; readonly options: MongoDocument } | undefined>;
  /** A modal question with one action; true when the user takes it. */
  readonly confirm: (
    message: string,
    detail: string | undefined,
    action: string,
  ) => Promise<boolean>;
  readonly texts: MongoTreeTexts;
}

export type MongoTreeCommandName =
  | 'newDatabase'
  | 'dropDatabase'
  | 'newCollection'
  | 'renameCollection'
  | 'dropCollection'
  | 'newIndex'
  | 'dropIndex';

type NodeOf<K extends TreeNode['kind']> = Extract<TreeNode, { kind: K }>;

function nodeOf<K extends TreeNode['kind']>(target: CommandTarget, kind: K): NodeOf<K> | undefined {
  return isTreeNode(target) && target.kind === kind ? (target as NodeOf<K>) : undefined;
}

export function mongoTreeCommandHandlers(
  deps: MongoTreeCommandDeps,
): Record<MongoTreeCommandName, (target?: CommandTarget) => Promise<undefined>> {
  const { texts } = deps;
  const session = async (connectionId: string) =>
    await mongoTreeSession(deps.manager, connectionId);

  /** Read-only refuses; production asks once (V4.6). */
  const mayChange = async (connectionId: string): Promise<boolean> => {
    const config = deps.store.get(connectionId);
    if (config?.readOnly === true) {
      throw new DbError('permission-denied', texts.readOnly);
    }
    if (config?.production !== true) {
      return true;
    }
    return await deps.confirm(texts.productionDetail(config.name), undefined, texts.changeAction);
  };

  /** A drop asks once: the production mark goes into that one question (D52). */
  const mayDrop = async (connectionId: string, message: string): Promise<boolean> => {
    const config = deps.store.get(connectionId);
    if (config?.readOnly === true) {
      throw new DbError('permission-denied', texts.readOnly);
    }
    const detail = config?.production === true ? texts.productionDetail(config.name) : undefined;
    return await deps.confirm(message, detail, texts.dropAction);
  };

  /** The connection of the clicked node, or a MongoDB connection the user picks. */
  const connectionOf = async (target: CommandTarget): Promise<string | undefined> => {
    const id = isTreeNode(target)
      ? 'connectionId' in target
        ? target.connectionId
        : undefined
      : target;
    if (id !== undefined && id !== '') {
      if (deps.store.get(id)?.driver !== 'mongodb') {
        throw new DbError('unsupported', texts.noMongo);
      }
      return id;
    }
    const mongo = deps.store.list().filter((config) => config.driver === 'mongodb');
    if (mongo.length === 0) {
      throw new DbError('not-found', texts.noMongo);
    }
    return await deps.pickConnection(mongo.map((config) => config.id));
  };

  const refreshDatabase = (connectionId: string, database: string): void => {
    deps.tree.refresh({ kind: 'mongoDatabase', connectionId, database });
  };

  return {
    newDatabase: async (target) => {
      const connectionId = await connectionOf(target);
      if (connectionId === undefined) {
        return undefined;
      }
      const database = await deps.askText({
        title: texts.newDatabase,
        prompt: texts.databaseName,
        check: databaseNameProblem,
      });
      if (database === undefined) {
        return undefined;
      }
      const collection = await deps.askText({
        title: texts.newDatabase,
        prompt: texts.firstCollection,
        check: collectionNameProblem,
      });
      if (collection === undefined || !(await mayChange(connectionId))) {
        return undefined;
      }
      await createDatabase(await session(connectionId), database, collection);
      deps.tree.refresh({ kind: 'connection', connectionId });
      return undefined;
    },

    dropDatabase: async (target) => {
      const node = nodeOf(target, 'mongoDatabase');
      if (node === undefined) {
        return undefined;
      }
      if (!(await mayDrop(node.connectionId, texts.dropDatabase(node.database)))) {
        return undefined;
      }
      // A whole database goes only when its name is typed back (D43).
      const typed = await deps.askText({
        title: texts.dropDatabase(node.database),
        prompt: texts.typeToDrop(node.database),
        check: (text) => (text === node.database ? undefined : texts.typeExactly),
      });
      if (typed !== node.database) {
        return undefined;
      }
      await dropDatabase(await session(node.connectionId), node.database);
      deps.tree.refresh({ kind: 'connection', connectionId: node.connectionId });
      return undefined;
    },

    newCollection: async (target) => {
      const node = nodeOf(target, 'mongoDatabase');
      if (node === undefined) {
        return undefined;
      }
      const asked = await deps.askNewCollection(node.database);
      if (asked === undefined || !(await mayChange(node.connectionId))) {
        return undefined;
      }
      await createCollection(
        await session(node.connectionId),
        node.database,
        asked.name,
        asked.options,
      );
      refreshDatabase(node.connectionId, node.database);
      return undefined;
    },

    renameCollection: async (target) => {
      const node = nodeOf(target, 'mongoCollection');
      if (node === undefined) {
        return undefined;
      }
      if (node.collectionType === 'view') {
        throw new DbError('unsupported', texts.renameView);
      }
      const name = await deps.askText({
        title: texts.renameCollection,
        prompt: texts.newName(node.collection),
        value: node.collection,
        check: collectionNameProblem,
      });
      if (name === undefined || name === node.collection || !(await mayChange(node.connectionId))) {
        return undefined;
      }
      await renameCollection(
        await session(node.connectionId),
        node.database,
        node.collection,
        name,
      );
      refreshDatabase(node.connectionId, node.database);
      return undefined;
    },

    dropCollection: async (target) => {
      const node = nodeOf(target, 'mongoCollection');
      if (node === undefined) {
        return undefined;
      }
      const message = texts.dropCollection(node.collection, node.collectionType === 'view');
      if (!(await mayDrop(node.connectionId, message))) {
        return undefined;
      }
      await dropCollection(await session(node.connectionId), node.database, node.collection);
      refreshDatabase(node.connectionId, node.database);
      return undefined;
    },

    newIndex: async (target) => {
      const node = nodeOf(target, 'mongoCollection');
      if (node === undefined || node.collectionType === 'view') {
        return undefined;
      }
      const asked = await deps.askIndex(node.collection);
      if (asked === undefined || !(await mayChange(node.connectionId))) {
        return undefined;
      }
      await createIndex(
        await session(node.connectionId),
        node.database,
        node.collection,
        asked.keys,
        asked.options,
      );
      deps.tree.refresh(node);
      return undefined;
    },

    dropIndex: async (target) => {
      const node = nodeOf(target, 'mongoIndex');
      if (node === undefined) {
        return undefined;
      }
      if (!(await mayDrop(node.connectionId, texts.dropIndex(node.index.name, node.collection)))) {
        return undefined;
      }
      await dropIndex(
        await session(node.connectionId),
        node.database,
        node.collection,
        node.index.name,
      );
      deps.tree.refresh({
        kind: 'mongoCollection',
        connectionId: node.connectionId,
        database: node.database,
        collection: node.collection,
        collectionType: 'collection',
      });
      return undefined;
    },
  };
}
