// The dialogs of the RabbitMQ commands (V13.26), made of the editor's input box, quick pick
// and modal questions. Kept apart from `rabbitmq-commands.ts` so that file stays testable
// without an editor.

import * as vscode from 'vscode';
import type { ConnectionStore } from '../../services/connection-store';
import { describeTarget } from '../../shared/connection';
import type { RabbitCommandUi } from './rabbitmq-commands';

export function rabbitCommandUi(store: Pick<ConnectionStore, 'get'>): RabbitCommandUi {
  return {
    input: async (options) =>
      await vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        ...(options.value === undefined ? {} : { value: options.value }),
        ...(options.validate === undefined
          ? {}
          : { validateInput: (value: string) => options.validate?.(value) }),
      }),

    pick: async (title, choices) =>
      await vscode.window.showQuickPick([...choices], { title, placeHolder: title }),

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
        { placeHolder: vscode.l10n.t('Pick a RabbitMQ connection') },
      );
      return chosen?.id;
    },

    info: (message) => {
      void vscode.window.showInformationMessage(message);
    },
  };
}
