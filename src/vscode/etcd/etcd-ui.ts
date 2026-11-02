// The dialogs of the etcd commands (V13.19), made of the editor's input box, quick pick
// and modal questions. Kept apart from `etcd-commands.ts` so that file stays testable
// without an editor.

import { homedir } from 'node:os';
import * as vscode from 'vscode';
import type { ConnectionStore } from '../../services/connection-store';
import { describeTarget } from '../../shared/connection';
import type { AccessPickItem } from './etcd-access-commands';
import type { EtcdClusterUi } from './etcd-cluster-commands';
import type { EtcdCommandUi } from './etcd-commands';

export function etcdCommandUi(store: Pick<ConnectionStore, 'get'>): EtcdClusterUi {
  const ui: EtcdCommandUi = {
    input: async (options) =>
      await vscode.window.showInputBox({
        title: options.title,
        prompt: options.prompt,
        ...(options.value === undefined ? {} : { value: options.value }),
        ...(options.placeHolder === undefined ? {} : { placeHolder: options.placeHolder }),
        ...(options.password === true ? { password: true } : {}),
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
  return {
    ...ui,
    saveFile: async (options) =>
      (
        await vscode.window.showSaveDialog({
          title: options.title,
          defaultUri: vscode.Uri.joinPath(
            vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(homedir()),
            options.defaultName,
          ),
          filters: { [options.filterName]: [...options.extensions] },
        })
      )?.fsPath,
    withProgress: async <T>(title: string, task: (signal: AbortSignal) => Promise<T>) =>
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title, cancellable: true },
        async (_progress, token) => {
          const abort = new AbortController();
          const subscription = token.onCancellationRequested(() => {
            abort.abort();
          });
          try {
            return await task(abort.signal);
          } finally {
            subscription.dispose();
          }
        },
      ),
    pick: async <T>(options: {
      readonly title: string;
      readonly placeHolder?: string;
      readonly items: readonly AccessPickItem<T>[];
    }) => {
      const chosen = await vscode.window.showQuickPick(
        options.items.map((item) => ({
          label: item.label,
          ...(item.description === undefined ? {} : { description: item.description }),
          ...(item.detail === undefined ? {} : { detail: item.detail }),
          ...(item.icon === undefined ? {} : { iconPath: new vscode.ThemeIcon(item.icon) }),
          value: item.value,
        })),
        {
          title: options.title,
          ...(options.placeHolder === undefined ? {} : { placeHolder: options.placeHolder }),
        },
      );
      return chosen?.value;
    },
  };
}
