// Connections of drivers that other extensions registered (V12.7). The webview form knows
// the built-in databases only, so these are made and edited with the editor's own input
// boxes: one question per field the driver asked for. The password goes to SecretStorage
// like any other (ConnectionStore), and the result is checked by the same rules.

import * as vscode from 'vscode';
import type { PluginField } from '../api/types';
import type { PluginDrivers, PluginInfo } from '../drivers/plugin/plugin-drivers';
import type { ConnectionStore, PasswordChange } from '../services/connection-store';
import {
  type ConnectionConfig,
  type ConnectionInput,
  connectionProblems,
  isPortValid,
} from '../shared/connection';

export interface PluginConnectionDeps {
  readonly store: ConnectionStore;
  readonly plugins: Pick<PluginDrivers, 'list' | 'describe'>;
}

export interface PluginConnectionHandlers {
  /** Asks which driver, then its fields; false when the user backed out. */
  add(): Promise<boolean>;
  /** Edits a saved connection of a plugin driver. */
  edit(id: string): Promise<boolean>;
  /** Whether any plugin driver is registered now. */
  available(): boolean;
}

/** What a field is asked as; one `l10n.t` call per text, so the bundle can translate each. */
function promptOf(field: Exclude<PluginField, 'password'>): string {
  switch (field) {
    case 'host':
      return vscode.l10n.t('Host');
    case 'port':
      return vscode.l10n.t('Port');
    case 'user':
      return vscode.l10n.t('User');
    case 'database':
      return vscode.l10n.t('Database');
    case 'file':
      return vscode.l10n.t('Database file');
  }
}

export function pluginConnectionHandlers(deps: PluginConnectionDeps): PluginConnectionHandlers {
  /** The answers to the questions of a driver, or undefined when the user cancelled. */
  const ask = async (
    info: PluginInfo,
    before: ConnectionConfig | undefined,
  ): Promise<{ input: ConnectionInput; password: PasswordChange } | undefined> => {
    const name = await vscode.window.showInputBox({
      title: info.label,
      prompt: vscode.l10n.t('Name of the connection'),
      value: before?.name ?? info.label,
      validateInput: (text) =>
        text.trim() === '' ? vscode.l10n.t('The name must not be empty') : undefined,
    });
    if (name === undefined) {
      return undefined;
    }
    const answers: {
      host?: string;
      port?: number;
      user?: string;
      database?: string;
      file?: string;
    } = {};
    let password: PasswordChange = { kind: 'keep' };
    for (const field of info.fields) {
      if (field === 'password') {
        const text = await vscode.window.showInputBox({
          title: info.label,
          prompt:
            before === undefined
              ? vscode.l10n.t('Password (leave empty for none)')
              : vscode.l10n.t('Password (leave empty to keep the saved one)'),
          password: true,
        });
        if (text === undefined) {
          return undefined;
        }
        if (text !== '') {
          password = { kind: 'set', value: text };
        }
        continue;
      }
      const current =
        field === 'port'
          ? (before?.port ?? info.defaultPort)?.toString()
          : (before?.[field] ?? undefined);
      const text = await vscode.window.showInputBox({
        title: info.label,
        prompt: promptOf(field),
        value: current ?? '',
        validateInput:
          field === 'port'
            ? (value) =>
                value.trim() === '' || isPortValid(Number(value))
                  ? undefined
                  : vscode.l10n.t('The port is a number from 1 to 65535')
            : undefined,
      });
      if (text === undefined) {
        return undefined;
      }
      const value = text.trim();
      if (value === '') {
        continue;
      }
      if (field === 'port') {
        answers.port = Number(value);
      } else {
        answers[field] = value;
      }
    }
    const input: ConnectionInput = {
      ...(before === undefined
        ? {}
        : // Settings the questions do not cover (colour, folder, flags) stay as they were.
          (({ id: _id, ...rest }) => rest)(before)),
      name: name.trim(),
      driver: 'plugin',
      plugin: info.id,
      host: answers.host,
      port: answers.port,
      user: answers.user,
      database: answers.database,
      file: answers.file,
    };
    return { input, password };
  };

  const save = async (info: PluginInfo, before: ConnectionConfig | undefined): Promise<boolean> => {
    const answered = await ask(info, before);
    if (answered === undefined) {
      return false;
    }
    const problems = connectionProblems(answered.input);
    if (problems.length > 0) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('Invalid connection: {0}', problems.join(', ')),
      );
      return false;
    }
    if (before === undefined) {
      await deps.store.add(
        answered.input,
        answered.password.kind === 'set' ? answered.password.value : undefined,
      );
    } else {
      await deps.store.update(before.id, answered.input, answered.password);
    }
    return true;
  };

  return {
    available: () => deps.plugins.list().length > 0,

    add: async () => {
      const drivers = deps.plugins.list();
      if (drivers.length === 0) {
        void vscode.window.showInformationMessage(
          vscode.l10n.t('No extension has added a database to DataNest yet'),
        );
        return false;
      }
      const picked = await vscode.window.showQuickPick(
        drivers.map((info) => ({ label: info.label, description: info.id, info })),
        { placeHolder: vscode.l10n.t('Pick the database') },
      );
      return picked === undefined ? false : await save(picked.info, undefined);
    },

    edit: async (id) => {
      const config = deps.store.get(id);
      if (config?.driver !== 'plugin' || config.plugin === undefined) {
        return false;
      }
      const info = deps.plugins.describe(config.plugin);
      if (info === undefined) {
        void vscode.window.showWarningMessage(
          vscode.l10n.t(
            'The driver "{0}" is not available: its extension is not installed or not active',
            config.plugin,
          ),
        );
        return false;
      }
      return await save(info, config);
    },
  };
}
