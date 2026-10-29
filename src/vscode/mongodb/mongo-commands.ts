// The MongoDB commands as the editor runs them (V7.5): the behaviour is in
// mongo-tree-commands.ts, the questions in mongo-questions.ts; this file joins them.

import * as vscode from 'vscode';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { describeTarget } from '../../shared/connection';
import { COMMAND_IDS } from '../command-ids';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';
import { askIndex, askNewCollection, askText } from './mongo-questions';
import { mongoTreeCommandHandlers } from './mongo-tree-commands';

export interface MongoCommandDeps {
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
  | 'mongoDropIndex'];

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
  };
}
