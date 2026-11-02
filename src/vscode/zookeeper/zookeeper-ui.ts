// The dialogs of the ZooKeeper commands (V13.24), made of the editor's input box, quick pick
// and modal questions. Kept apart from `zookeeper-commands.ts` so that file stays testable
// without an editor.

import * as vscode from 'vscode';
import type { ConnectionStore } from '../../services/connection-store';
import { describeTarget } from '../../shared/connection';
import type { ZookeeperCommandUi } from './zookeeper-commands';

export function zookeeperCommandUi(store: Pick<ConnectionStore, 'get'>): ZookeeperCommandUi {
  return {
    input: async (options) =>
      await vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        ...(options.value === undefined ? {} : { value: options.value }),
        ...(options.placeHolder === undefined ? {} : { placeHolder: options.placeHolder }),
        ...(options.validate === undefined
          ? {}
          : { validateInput: (value: string) => options.validate?.(value) }),
      }),

    pickMode: async () => {
      const chosen = await vscode.window.showQuickPick(
        [
          {
            label: vscode.l10n.t('Persistent'),
            description: vscode.l10n.t('Stays until somebody deletes it'),
            iconPath: new vscode.ThemeIcon('symbol-file', new vscode.ThemeColor('charts.yellow')),
            mode: 'persistent' as const,
          },
          {
            label: vscode.l10n.t('Sequential'),
            description: vscode.l10n.t('The server adds a counter to the name'),
            iconPath: new vscode.ThemeIcon('list-ordered', new vscode.ThemeColor('charts.green')),
            mode: 'sequential' as const,
          },
          {
            label: vscode.l10n.t('Container'),
            description: vscode.l10n.t('Deleted by the server once its last child is gone'),
            iconPath: new vscode.ThemeIcon('package', new vscode.ThemeColor('charts.purple')),
            mode: 'container' as const,
          },
        ],
        { title: vscode.l10n.t('How does the znode live?') },
      );
      return chosen?.mode;
    },

    confirm: async (message, detail, action) => {
      const answer = await vscode.window.showWarningMessage(
        message,
        { modal: true, ...(detail === undefined ? {} : { detail }) },
        action,
      );
      return answer === action;
    },

    pickConnection: async (ids) => {
      const chosen = await vscode.window.showQuickPick(
        ids.map((id) => {
          const config = store.get(id);
          return {
            label: config?.name ?? id,
            description: config === undefined ? '' : describeTarget(config),
            id,
          };
        }),
        { placeHolder: vscode.l10n.t('Pick a ZooKeeper connection') },
      );
      return chosen?.id;
    },

    info: (message) => {
      void vscode.window.showInformationMessage(message);
    },
  };
}
