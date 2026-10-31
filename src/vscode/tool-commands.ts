// The tools of V10.2.6: "Find Data…" across the tables of a database or schema,
// "Document Database…" as Markdown, and "Open in Terminal" with the database's own
// command-line client.

import * as vscode from 'vscode';
import { formatCount } from '../core/number-format';
import type { Logger } from '../core/logging/logger';
import type { ObjectScope, TableRef } from '../core/model/objects';
import { CLI_PROGRAMS, cliCommand, findOnPath } from '../services/cli-command';
import { ConnectionManager, type SessionTarget } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import { type DataSearchHit, MAX_SEARCH_TEXT, searchData } from '../services/data-search';
import { readSchemaSnapshot } from '../services/schema-compare/snapshot';
import { schemaDocument } from '../services/schema-docs';
import { isSqlDriver } from '../shared/connection';
import type { TableFilter } from '../shared/table-filter';
import { pickConnection, pickScope } from './connection-pick';
import { dumpStartOf } from './tree/dump-target';
import { connectionIdOf, isTreeNode } from './tree/nodes';

export interface ToolCommandDeps {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly logger: Logger;
  /** Opens a table page by page, filtered. */
  readonly openFiltered: (
    target: SessionTarget,
    table: TableRef,
    filter: TableFilter,
  ) => Promise<void>;
}

let nextTask = 1;

function targetOf(connectionId: string, scope: ObjectScope): SessionTarget {
  return scope.database === undefined
    ? { connectionId }
    : { connectionId, database: scope.database };
}

function scopeLabel(connectionName: string, scope: ObjectScope): string {
  return [connectionName, scope.database, scope.schema]
    .filter((part) => part !== undefined)
    .join(' / ');
}

export function toolCommandHandlers(deps: ToolCommandDeps): {
  findData: (target?: unknown) => Promise<void>;
  documentSchema: (target?: unknown) => Promise<void>;
  openTerminal: (target?: unknown) => Promise<void>;
} {
  /** The connection and scope a command works on: from the tree node, or asked for. */
  const chooseScope = async (
    target: unknown,
    title: string,
  ): Promise<{ connectionId: string; scope: ObjectScope } | undefined> => {
    const start = isTreeNode(target)
      ? dumpStartOf(target, undefined)
      : await (async () => {
          const connectionId = await pickConnection(deps.store, title);
          return connectionId === undefined ? undefined : { connectionId, scope: undefined };
        })();
    if (start === undefined) {
      return undefined;
    }
    const scope = await pickScope(
      deps.manager,
      start.connectionId,
      start.scope,
      vscode.l10n.t('Pick the schema'),
    );
    return scope === undefined ? undefined : { connectionId: start.connectionId, scope };
  };

  const findData = async (target?: unknown): Promise<void> => {
    const chosen = await chooseScope(target, vscode.l10n.t('Pick the connection to search'));
    if (chosen === undefined) {
      return;
    }
    const { connectionId, scope } = chosen;
    const config = deps.store.get(connectionId);
    if (config === undefined || !isSqlDriver(config.driver)) {
      return;
    }
    const where = scopeLabel(config.name, scope);
    const text = await vscode.window.showInputBox({
      title: vscode.l10n.t('Find Data in "{0}"', where),
      prompt: vscode.l10n.t(
        'Text to look for in every text column of every table, without regard to case',
      ),
      validateInput: (value) =>
        value.trim() === '' ? vscode.l10n.t('Type what to look for') : undefined,
    });
    if (text === undefined || text.trim() === '') {
      return;
    }
    const sought = text.trim().slice(0, MAX_SEARCH_TEXT);
    const driver = await deps.manager.driverOf(connectionId);
    const owner = ConnectionManager.taskOwner(`data-search-${nextTask++}`);
    const report = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Looking for "{0}" in {1}', sought, where),
        cancellable: true,
      },
      async (progress, token) => {
        const session = await deps.manager.acquire(owner, targetOf(connectionId, scope));
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => {
          abort.abort();
          session.cancel().catch((error: unknown) => {
            deps.logger.warn('Cancelling a data search failed', error);
          });
        });
        try {
          return await searchData({
            session,
            dialect: driver.dialect,
            driver: config.driver as Parameters<typeof searchData>[0]['driver'],
            scope,
            text: sought,
            signal: abort.signal,
            onProgress: (done, total, table) => {
              progress.report({
                message: vscode.l10n.t('{0} — table {1} of {2}', table, done + 1, total),
                increment: total === 0 ? 0 : 100 / total,
              });
            },
          });
        } finally {
          subscription.dispose();
          await deps.manager.release(owner);
        }
      },
    );
    for (const failure of report.failures) {
      deps.logger.warn(`Find Data skipped ${failure.table}: ${failure.error}`);
    }
    if (report.hits.length === 0) {
      void vscode.window.showInformationMessage(
        report.cancelled
          ? vscode.l10n.t('Stopped: "{0}" was not found in the tables looked through', sought)
          : report.failures.length === 0
            ? vscode.l10n.t('"{0}" is in none of the {1} tables', sought, report.tables)
            : vscode.l10n.t(
                '"{0}" is in none of the tables; {1} could not be read (see the log)',
                sought,
                report.failures.length,
              ),
      );
      return;
    }
    const language = vscode.env.language;
    const items = report.hits.map((hit) => ({
      label: `$(table) ${hit.table.name}`,
      description: vscode.l10n.t('{0} rows', formatCount(hit.rows, language)),
      detail: hit.columns
        .map((column) => `${column.name} (${formatCount(column.rows, language)})`)
        .join(', '),
      hit,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('"{0}" in {1}', sought, where),
      placeHolder: report.cancelled
        ? vscode.l10n.t('Stopped early. Pick a table to open the rows that hold it')
        : report.failures.length === 0
          ? vscode.l10n.t('Pick a table to open the rows that hold it')
          : vscode.l10n.t(
              'Pick a table to open the rows that hold it; {0} tables could not be read (see the log)',
              report.failures.length,
            ),
      matchOnDetail: true,
    });
    if (picked !== undefined) {
      await openHit(picked.hit);
    }

    async function openHit(hit: DataSearchHit): Promise<void> {
      await deps.openFiltered(targetOf(connectionId, scope), hit.table, {
        conditions: [],
        where: hit.where,
      });
    }
  };

  const documentSchema = async (target?: unknown): Promise<void> => {
    const chosen = await chooseScope(target, vscode.l10n.t('Pick the connection to document'));
    if (chosen === undefined) {
      return;
    }
    const { connectionId, scope } = chosen;
    const config = deps.store.get(connectionId);
    if (config === undefined) {
      return;
    }
    const driver = await deps.manager.driverOf(connectionId);
    const owner = ConnectionManager.taskOwner(`document-${nextTask++}`);
    const title =
      [scope.database, scope.schema].filter((part) => part !== undefined).join('.') || config.name;
    const markdown = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t('Reading the structure of {0}', scopeLabel(config.name, scope)),
        cancellable: true,
      },
      async (progress, token) => {
        const session = await deps.manager.acquire(owner, targetOf(connectionId, scope));
        const abort = new AbortController();
        const subscription = token.onCancellationRequested(() => {
          abort.abort();
        });
        try {
          const snapshot = await readSchemaSnapshot(session.metadata, scope, {
            kinds: driver.capabilities.objectKinds,
            signal: abort.signal,
            onProgress: (done, total) => {
              progress.report({ message: vscode.l10n.t('{0} of {1}', done, total) });
            },
          });
          return schemaDocument(snapshot, {
            title,
            connection: config.name,
            date: new Date().toISOString().slice(0, 10),
          });
        } finally {
          subscription.dispose();
          await deps.manager.release(owner);
        }
      },
    );
    const document = await vscode.workspace.openTextDocument({
      language: 'markdown',
      content: markdown,
    });
    await vscode.window.showTextDocument(document, { preview: false });
  };

  const openTerminal = async (target?: unknown): Promise<void> => {
    const connectionId =
      (isTreeNode(target) ? connectionIdOf(target) : undefined) ??
      (await pickConnection(deps.store, vscode.l10n.t('Pick a connection')));
    if (connectionId === undefined) {
      return;
    }
    const config = deps.store.get(connectionId);
    if (config === undefined) {
      return;
    }
    const programs = CLI_PROGRAMS[config.driver];
    const program = programs
      .map((name) => findOnPath(name))
      .find((path): path is string => path !== undefined);
    if (programs.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This kind of database has no command-line client to open'),
      );
      return;
    }
    if (program === undefined) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t(
          'None of {0} is installed or on the PATH. Install the client of the database to open it here.',
          programs.join(', '),
        ),
      );
      return;
    }
    const lease = await deps.manager.leaseEndpoint(connectionId);
    const password = await deps.store.getPassword(connectionId);
    const command = cliCommand(config, program, lease.endpoint, password);
    if (command === undefined) {
      await lease.release();
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'The command-line client cannot reach this kind of setup (a cluster, Sentinels or a replica set)',
        ),
      );
      return;
    }
    const terminal = vscode.window.createTerminal({
      name: `DataNest: ${config.name}`,
      shellPath: command.program,
      shellArgs: [...command.args],
      env: { ...command.env },
      iconPath: new vscode.ThemeIcon('database'),
    });
    // The tunnel lives as long as the terminal that uses it.
    const closing = vscode.window.onDidCloseTerminal((closed) => {
      if (closed === terminal) {
        closing.dispose();
        void lease.release();
      }
    });
    terminal.show();
    if (command.asksPassword) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          '{0} asks for the password in the terminal',
          program.split(/[\\/]/u).at(-1) ?? program,
        ),
      );
    }
  };

  return { findData, documentSchema, openTerminal };
}
