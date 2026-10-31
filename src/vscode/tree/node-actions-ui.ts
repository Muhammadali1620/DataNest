// The list the "actions" button of a tree item opens (V11.12): the same commands as the
// right-click menu, each with its icon, picked from a quick pick.

import * as vscode from 'vscode';
import { COMMAND_IDS } from '../command-ids';
import { actionsOf } from './node-actions';
import type { TreeNode } from './nodes';

/** The words and icon of each command on the list; one place, so a test can see none is missing. */
export function actionLabels(): Readonly<Record<string, { label: string; icon: string }>> {
  return {
    [COMMAND_IDS.openTable]: { label: vscode.l10n.t('Open Table'), icon: 'table' },
    [COMMAND_IDS.designTable]: { label: vscode.l10n.t('Edit Table'), icon: 'edit' },
    [COMMAND_IDS.showDefinition]: { label: vscode.l10n.t('Show Definition'), icon: 'file-code' },
    [COMMAND_IDS.generateSelect]: { label: vscode.l10n.t('Generate SELECT'), icon: 'wand' },
    [COMMAND_IDS.showErDiagram]: { label: vscode.l10n.t('ER Diagram'), icon: 'type-hierarchy' },
    [COMMAND_IDS.renameTable]: { label: vscode.l10n.t('Rename'), icon: 'symbol-keyword' },
    [COMMAND_IDS.duplicateTable]: { label: vscode.l10n.t('Duplicate Table'), icon: 'copy' },
    [COMMAND_IDS.copyName]: { label: vscode.l10n.t('Copy Name'), icon: 'clippy' },
    [COMMAND_IDS.refreshTree]: { label: vscode.l10n.t('Refresh'), icon: 'refresh' },
    [COMMAND_IDS.truncateTable]: { label: vscode.l10n.t('Empty Table'), icon: 'clear-all' },
    [COMMAND_IDS.dropTable]: { label: vscode.l10n.t('Drop'), icon: 'trash' },
    [COMMAND_IDS.openNodeSql]: { label: vscode.l10n.t('Open SQL'), icon: 'file-code' },
    [COMMAND_IDS.moveColumnUp]: { label: vscode.l10n.t('Move Column Up'), icon: 'arrow-up' },
    [COMMAND_IDS.moveColumnDown]: { label: vscode.l10n.t('Move Column Down'), icon: 'arrow-down' },
    [COMMAND_IDS.editObject]: { label: vscode.l10n.t('Edit Definition'), icon: 'edit' },
    [COMMAND_IDS.dropObject]: { label: vscode.l10n.t('Drop'), icon: 'trash' },
    [COMMAND_IDS.openSavedQuery]: { label: vscode.l10n.t('Open Query'), icon: 'go-to-file' },
    [COMMAND_IDS.renameSavedQuery]: { label: vscode.l10n.t('Rename'), icon: 'symbol-keyword' },
    [COMMAND_IDS.deleteSavedQuery]: { label: vscode.l10n.t('Delete'), icon: 'trash' },
    [COMMAND_IDS.openAccount]: {
      label: vscode.l10n.t('Open in Users and Privileges'),
      icon: 'organization',
    },
  };
}

/** Lists what the node can do and runs the pick on it. */
export async function showNodeActions(node: TreeNode): Promise<void> {
  const labels = actionLabels();
  const items = actionsOf(node).flatMap((command) => {
    const shown = labels[command];
    return shown === undefined ? [] : [{ label: `$(${shown.icon}) ${shown.label}`, command }];
  });
  if (items.length === 0) {
    return;
  }
  const picked = await vscode.window.showQuickPick(items, {
    title: vscode.l10n.t('Actions'),
    placeHolder: vscode.l10n.t('Pick an action'),
  });
  if (picked !== undefined) {
    await vscode.commands.executeCommand(picked.command, node);
  }
}
