// The Elasticsearch commands as the editor runs them (V7.8): the tree's changes, the
// query editors, and showing an index's mapping through a request.

import * as vscode from 'vscode';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { describeTarget } from '../../shared/connection';
import { COMMAND_IDS } from '../command-ids';
import { askText } from '../mongodb/mongo-questions';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';
import type { ElasticEditors } from './elastic-editors';
import { elasticTreeCommandHandlers } from './elastic-tree-commands';

export interface ElasticCommandDeps {
  readonly manager: ConnectionManager;
  readonly store: ConnectionStore;
  readonly tree: RefreshableTree;
  readonly editors: ElasticEditors;
}

type ElasticCommandId = (typeof COMMAND_IDS)[
  | 'elasticNewIndex'
  | 'elasticDeleteIndex'
  | 'elasticNewQuery'
  | 'elasticRunQuery'
  | 'elasticRunRequest'
  | 'elasticPickConnection'];

export function elasticCommands(
  deps: ElasticCommandDeps,
): Record<ElasticCommandId, (target?: CommandTarget) => unknown> {
  const handlers = elasticTreeCommandHandlers({
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
        { placeHolder: vscode.l10n.t('Pick an Elasticsearch connection') },
      );
      return chosen?.id;
    },
    askText,
    confirm: async (message, detail, action) =>
      (await vscode.window.showWarningMessage(
        message,
        { modal: true, ...(detail === undefined ? {} : { detail }) },
        action,
      )) === action,
    texts: {
      newIndex: vscode.l10n.t('New Elasticsearch Index'),
      indexName: vscode.l10n.t('The name of the index, in lowercase'),
      indexBody: vscode.l10n.t('Its settings and mappings as JSON; empty for the defaults'),
      deleteIndex: (name) => vscode.l10n.t('Delete the index "{0}" with all its documents?', name),
      typeToDelete: (name) => vscode.l10n.t('Type "{0}" to delete it', name),
      typeExactly: vscode.l10n.t('Type the name exactly as shown'),
      deleteAction: vscode.l10n.t('Delete'),
      productionDetail: (connection) =>
        vscode.l10n.t('"{0}" is a production connection.', connection),
      changeAction: vscode.l10n.t('Change'),
      readOnly: vscode.l10n.t('The connection is read-only: nothing may change'),
      noElastic: vscode.l10n.t('There is no Elasticsearch connection yet'),
    },
  });
  return {
    [COMMAND_IDS.elasticNewIndex]: handlers.newIndex,
    [COMMAND_IDS.elasticDeleteIndex]: handlers.deleteIndex,
    [COMMAND_IDS.elasticNewQuery]: async (target) => {
      await deps.editors.newQuery(target);
    },
    [COMMAND_IDS.elasticRunQuery]: async () => {
      await deps.editors.runAtCursor();
    },
    [COMMAND_IDS.elasticRunRequest]: async (range) => {
      await deps.editors.runRequest(range);
    },
    [COMMAND_IDS.elasticPickConnection]: async () => {
      await deps.editors.pickConnection();
    },
  };
}
