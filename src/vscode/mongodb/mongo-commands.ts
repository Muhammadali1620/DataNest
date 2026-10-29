// The MongoDB commands as the editor runs them (V7.5): the behaviour is in
// mongo-tree-commands.ts, the questions in mongo-questions.ts; this file joins them.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import type { ConnectionManager } from '../../services/connection-manager';
import { policyOf } from '../../services/write-policy';
import type { ConnectionStore } from '../../services/connection-store';
import { describeTarget } from '../../shared/connection';
import { COMMAND_IDS } from '../command-ids';
import { MongoDocumentsModel } from '../panels/mongo-documents-model';
import { MongoDocumentsPanel } from '../panels/mongo-documents-panel';
import { readQueryTimeoutMs } from '../settings';
import { isTreeNode, type MongoCollectionNode } from '../tree/nodes';
import { mongoTreeSession } from '../tree/mongo-tree';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';
import { askIndex, askNewCollection, askText } from './mongo-questions';
import { mongoTreeCommandHandlers } from './mongo-tree-commands';

export interface MongoCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly manager: ConnectionManager;
  readonly store: ConnectionStore;
  readonly tree: RefreshableTree;
}

type MongoCommandId = (typeof COMMAND_IDS)[
  | 'mongoNewDatabase'
  | 'mongoDropDatabase'
  | 'mongoNewCollection'
  | 'mongoRenameCollection'
  | 'mongoDropCollection'
  | 'mongoNewIndex'
  | 'mongoDropIndex'
  | 'mongoOpenCollection'];

export function mongoCommands(
  deps: MongoCommandDeps,
): Record<MongoCommandId, (target?: CommandTarget) => unknown> {
  const handlers = mongoTreeCommandHandlers({
    manager: deps.manager,
    store: deps.store,
    tree: deps.tree,
    pickConnection: async (ids) => {
      const chosen = await vscode.window.showQuickPick(
        ids.map((id) => {
          const config = deps.store.get(id);
          return {
            label: config?.name ?? id,
            description: config === undefined ? '' : describeTarget(config),
            id,
          };
        }),
        { placeHolder: vscode.l10n.t('Pick a MongoDB connection') },
      );
      return chosen?.id;
    },
    askText,
    askNewCollection,
    askIndex,
    closePages: (connectionId, database, collection) => {
      MongoDocumentsPanel.closeCollection(connectionId, database, collection);
    },
    confirm: async (message, detail, action) =>
      (await vscode.window.showWarningMessage(
        message,
        { modal: true, ...(detail === undefined ? {} : { detail }) },
        action,
      )) === action,
    texts: {
      newDatabase: vscode.l10n.t('New MongoDB Database'),
      databaseName: vscode.l10n.t('The name of the database'),
      firstCollection: vscode.l10n.t(
        'The name of its first collection: MongoDB keeps no empty databases',
      ),
      renameCollection: vscode.l10n.t('Rename Collection'),
      newName: (current) => vscode.l10n.t('The new name of "{0}"', current),
      dropDatabase: (name) =>
        vscode.l10n.t('Drop the database "{0}" with all its collections?', name),
      typeToDrop: (name) => vscode.l10n.t('Type "{0}" to drop it', name),
      typeExactly: vscode.l10n.t('Type the name exactly as shown'),
      dropCollection: (name, view) =>
        view
          ? vscode.l10n.t(
              'Drop the view "{0}"? Its documents stay in the collection it reads.',
              name,
            )
          : vscode.l10n.t('Drop the collection "{0}" with all its documents and indexes?', name),
      dropIndex: (name, collection) =>
        vscode.l10n.t('Drop the index "{0}" of "{1}"?', name, collection),
      dropAction: vscode.l10n.t('Drop'),
      productionDetail: (connection) =>
        vscode.l10n.t('"{0}" is a production connection.', connection),
      changeAction: vscode.l10n.t('Change'),
      readOnly: vscode.l10n.t('The connection is read-only: nothing may change'),
      noMongo: vscode.l10n.t('There is no MongoDB connection yet'),
      renameView: vscode.l10n.t('A view cannot be renamed: drop it and create it again'),
    },
  });
  return {
    [COMMAND_IDS.mongoNewDatabase]: handlers.newDatabase,
    [COMMAND_IDS.mongoDropDatabase]: handlers.dropDatabase,
    [COMMAND_IDS.mongoNewCollection]: handlers.newCollection,
    [COMMAND_IDS.mongoRenameCollection]: handlers.renameCollection,
    [COMMAND_IDS.mongoDropCollection]: handlers.dropCollection,
    [COMMAND_IDS.mongoNewIndex]: handlers.newIndex,
    [COMMAND_IDS.mongoDropIndex]: handlers.dropIndex,
    [COMMAND_IDS.mongoOpenCollection]: (target) => {
      if (isTreeNode(target) && target.kind === 'mongoCollection') {
        openCollection(deps, target);
      }
      return undefined;
    },
  };
}

/** Opens the documents page of a collection or view (V7.6). */
function openCollection(deps: MongoCommandDeps, node: MongoCollectionNode): void {
  const config = deps.store.get(node.connectionId);
  if (config === undefined) {
    return;
  }
  MongoDocumentsPanel.show({
    extensionUri: deps.extensionUri,
    logger: deps.logger,
    connectionId: node.connectionId,
    database: node.database,
    collection: node.collection,
    policy: policyOf(config),
    model: new MongoDocumentsModel({
      connectionName: config.name,
      database: node.database,
      collection: node.collection,
      collectionType: node.collectionType,
      readOnly: config.readOnly === true,
      session: async () => await mongoTreeSession(deps.manager, node.connectionId),
      // A connection's own timeout (V4.9) wins over the setting.
      maxTimeMS: () => {
        const own = deps.store.get(node.connectionId)?.options?.queryTimeout;
        return own === undefined ? readQueryTimeoutMs() : own * 1000;
      },
    }),
  });
}
