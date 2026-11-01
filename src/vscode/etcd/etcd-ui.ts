// The dialogs of the etcd commands (V13.19), made of the editor's input box, quick pick
// and modal questions. Kept apart from `etcd-commands.ts` so that file stays testable
// without an editor.

import * as vscode from 'vscode';
import type { ConnectionStore } from '../../services/connection-store';
import { describeTarget } from '../../shared/connection';
import type { EtcdCommandUi } from './etcd-commands';

export function etcdCommandUi(store: Pick<ConnectionStore, 'get'>): EtcdCommandUi {
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

    pickKey: async (options) => {
      const items = options.keys.map((key) => ({
        label: key.text,
        iconPath: new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.yellow')),
        key,
      }));
      const chosen = await vscode.window.showQuickPick(items, {
        title: options.title,
        placeHolder: options.more
          ? vscode.l10n.t(
              'The first {0} keys; type a longer beginning to narrow the list',
              items.length,
            )
          : vscode.l10n.t('{0} keys', items.length),
        matchOnDescription: false,
      });
      return chosen?.key;
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
        { placeHolder: vscode.l10n.t('Pick an etcd connection') },
      );
      return chosen?.id;
    },

    info: (message) => {
      void vscode.window.showInformationMessage(message);
    },
  };
}
