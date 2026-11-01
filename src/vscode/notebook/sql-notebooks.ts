// SQL notebooks (V12.1): `*.sqlnb` files with cells of SQL and Markdown. A cell runs
// like a statement in an editor — same checks, same connection rules, one session for
// the whole notebook, so a temporary table made in one cell is there in the next — and
// its result appears under it as a table. Results are not saved in the file.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { ConnectionManager, type SessionTarget } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { doneLine, NOTEBOOK_ROW_LIMIT, tableOutput } from '../../services/notebook-output';
import { NOTEBOOK_TYPE } from '../../services/notebook-file';
import type { ProjectConnections } from '../../services/project-connections';
import { projectConnectionId } from '../../services/project-connections';
import { projectLocalId } from '../../services/project-queries';
import type { ResultStore } from '../../services/result-store';
import type { QueryRunner } from '../../services/query-runner';
import { pickConnection, pickDatabase } from '../connection-pick';
import { COMMAND_IDS } from '../command-ids';
import type { DocumentBindings } from '../editor/document-bindings';
import type { CheckedOutcome, CheckedRunRequest } from '../editor/run-query';
import { SQL_LANGUAGE_ID } from '../editor/query-editor';
import { metadataOf, type NotebookMetadata, SqlNotebookSerializer } from './serializer';

export interface SqlNotebooksDeps {
  readonly store: ConnectionStore;
  readonly projects: Pick<ProjectConnections, 'folders' | 'folderOf'>;
  readonly manager: ConnectionManager;
  readonly runner: Pick<QueryRunner, 'cancel'>;
  readonly results: Pick<ResultStore, 'window' | 'clearDocument'>;
  /** The editor's run with its checks, without a result panel. */
  readonly run: (request: CheckedRunRequest) => Promise<CheckedOutcome>;
  readonly bindings: DocumentBindings;
  readonly logger: Logger;
}

export class SqlNotebooks implements vscode.Disposable {
  private readonly controller: vscode.NotebookController;
  private readonly status: vscode.StatusBarItem;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: SqlNotebooksDeps) {
    this.controller = vscode.notebooks.createNotebookController(
      'datanest-sql-controller',
      NOTEBOOK_TYPE,
      'DataNest',
    );
    this.controller.supportedLanguages = [SQL_LANGUAGE_ID];
    this.controller.supportsExecutionOrder = true;
    this.controller.description = vscode.l10n.t('Run SQL on a DataNest connection');
    this.controller.executeHandler = (cells, notebook) => this.execute(cells, notebook);
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.status.command = COMMAND_IDS.selectNotebookConnection;
    this.subscriptions.push(
      vscode.workspace.registerNotebookSerializer(NOTEBOOK_TYPE, new SqlNotebookSerializer()),
      this.controller,
      this.status,
      vscode.window.onDidChangeActiveNotebookEditor(() => {
        this.updateStatus();
      }),
      vscode.workspace.onDidOpenNotebookDocument((notebook) => {
        this.opened(notebook);
      }),
      vscode.workspace.onDidChangeNotebookDocument((event) => {
        if (event.notebook.notebookType === NOTEBOOK_TYPE) {
          this.bindCells(event.notebook);
          this.updateStatus();
        }
      }),
      vscode.workspace.onDidCloseNotebookDocument((notebook) => {
        void this.closed(notebook);
      }),
      deps.store.onDidChange(() => {
        this.updateStatus();
      }),
    );
    for (const notebook of vscode.workspace.notebookDocuments) {
      this.opened(notebook);
    }
    this.updateStatus();
  }

  /** A new notebook with one empty SQL cell, bound to a connection if one is given. */
  async create(): Promise<void> {
    const notebook = await vscode.workspace.openNotebookDocument(
      NOTEBOOK_TYPE,
      new vscode.NotebookData([
        new vscode.NotebookCellData(vscode.NotebookCellKind.Code, '', SQL_LANGUAGE_ID),
      ]),
    );
    await vscode.window.showNotebookDocument(notebook);
  }

  /** Asks for the connection (and database) of the notebook in front of the user. */
  async selectConnection(): Promise<void> {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (notebook?.notebookType !== NOTEBOOK_TYPE) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a SQL notebook first: DataNest: New SQL Notebook'),
      );
      return;
    }
    await this.pick(notebook);
  }

  dispose(): void {
    for (const subscription of this.subscriptions.reverse()) {
      subscription.dispose();
    }
    this.subscriptions.length = 0;
  }

  /** The id the connection has on this computer for the id written in the file. */
  private resolve(written: string | undefined): string | undefined {
    if (written === undefined) {
      return undefined;
    }
    if (this.deps.store.get(written) !== undefined) {
      return written;
    }
    return this.deps.projects
      .folders()
      .map((folder) => projectConnectionId(folder.key, written))
      .find((id) => this.deps.store.get(id) !== undefined);
  }

  /** The id to write in the file: the project file's own id for a project connection. */
  private portable(connectionId: string): string {
    const folder = this.deps.projects.folderOf(connectionId);
    return (
      (folder === undefined ? undefined : projectLocalId(folder, connectionId)) ?? connectionId
    );
  }

  private targetOf(notebook: vscode.NotebookDocument): SessionTarget | undefined {
    const metadata = metadataOf(notebook.metadata);
    const connectionId = this.resolve(metadata.connection);
    if (connectionId === undefined) {
      return undefined;
    }
    return metadata.database === undefined
      ? { connectionId }
      : { connectionId, database: metadata.database };
  }

  private async pick(notebook: vscode.NotebookDocument): Promise<SessionTarget | undefined> {
    const connectionId = await pickConnection(this.deps.store);
    if (connectionId === undefined) {
      return undefined;
    }
    const database = await pickDatabase(this.deps.manager, connectionId);
    const metadata: NotebookMetadata = {
      connection: this.portable(connectionId),
      ...(this.deps.store.get(connectionId)?.name === undefined
        ? {}
        : { connectionName: this.deps.store.get(connectionId)?.name ?? '' }),
      ...(database === undefined ? {} : { database }),
    };
    const edit = new vscode.WorkspaceEdit();
    edit.set(notebook.uri, [vscode.NotebookEdit.updateNotebookMetadata({ ...metadata })]);
    await vscode.workspace.applyEdit(edit);
    // A new place is a new session: the one of the old place is let go.
    await this.release(notebook);
    this.bindCells(notebook);
    this.updateStatus();
    return database === undefined ? { connectionId } : { connectionId, database };
  }

  private async release(notebook: vscode.NotebookDocument): Promise<void> {
    try {
      await this.deps.manager.release(ConnectionManager.editorOwner(notebook.uri.toString()));
    } catch (error) {
      this.deps.logger.warn('Could not release the session of a notebook', error);
    }
  }

  /** A notebook of ours: the only kernel it has is chosen at once, and its cells bound. */
  private opened(notebook: vscode.NotebookDocument): void {
    if (notebook.notebookType === NOTEBOOK_TYPE) {
      this.controller.updateNotebookAffinity(notebook, vscode.NotebookControllerAffinity.Preferred);
    }
    this.bindCells(notebook);
  }

  /** Binds the cells to the notebook's connection, so completion and hover know the schema. */
  private bindCells(notebook: vscode.NotebookDocument): void {
    if (notebook.notebookType !== NOTEBOOK_TYPE) {
      return;
    }
    const target = this.targetOf(notebook);
    for (const cell of notebook.getCells()) {
      const uri = cell.document.uri.toString();
      if (cell.kind === vscode.NotebookCellKind.Code && target !== undefined) {
        this.deps.bindings.bind(uri, target);
      } else {
        this.deps.bindings.unbind(uri);
      }
    }
  }

  private async closed(notebook: vscode.NotebookDocument): Promise<void> {
    if (notebook.notebookType !== NOTEBOOK_TYPE) {
      return;
    }
    for (const cell of notebook.getCells()) {
      this.deps.bindings.unbind(cell.document.uri.toString());
    }
    this.deps.results.clearDocument(notebook.uri.toString());
    await this.release(notebook);
  }

  private updateStatus(): void {
    const notebook = vscode.window.activeNotebookEditor?.notebook;
    if (notebook?.notebookType !== NOTEBOOK_TYPE) {
      this.status.hide();
      return;
    }
    const metadata = metadataOf(notebook.metadata);
    const connectionId = this.resolve(metadata.connection);
    const name =
      connectionId === undefined
        ? undefined
        : (this.deps.store.get(connectionId)?.name ?? metadata.connectionName);
    this.status.text =
      name === undefined
        ? `$(database) ${vscode.l10n.t('Select a connection')}`
        : `$(database) ${name}${metadata.database === undefined ? '' : ` / ${metadata.database}`}`;
    this.status.tooltip = vscode.l10n.t('Connection of this notebook (click to change)');
    this.status.show();
  }

  private async execute(
    cells: readonly vscode.NotebookCell[],
    notebook: vscode.NotebookDocument,
  ): Promise<void> {
    for (const cell of cells) {
      if (cell.kind !== vscode.NotebookCellKind.Code) {
        continue;
      }
      const stopped = await this.executeCell(cell, notebook);
      if (stopped) {
        // A failed or cancelled cell stops the rest, as it does in an editor's script.
        break;
      }
    }
  }

  /** Runs one cell; true when the cells after it should not run. */
  private async executeCell(
    cell: vscode.NotebookCell,
    notebook: vscode.NotebookDocument,
  ): Promise<boolean> {
    const execution = this.controller.createNotebookCellExecution(cell);
    const documentUri = notebook.uri.toString();
    execution.start(Date.now());
    await execution.clearOutput();
    const cancellation = execution.token.onCancellationRequested(() => {
      void this.deps.runner.cancel(documentUri);
    });
    let success: boolean | undefined = false;
    try {
      const sql = cell.document.getText();
      if (sql.trim() === '') {
        success = true;
        return false;
      }
      const target = this.targetOf(notebook) ?? (await this.pick(notebook));
      if (target === undefined) {
        success = undefined;
        return true;
      }
      const checked = await this.deps.run({ documentUri, target, sql, showPanel: false });
      if (!checked.ok) {
        if (checked.error !== undefined) {
          await execution.replaceOutput(errorOutput(checked.error));
        }
        success = checked.error === undefined ? undefined : false;
        return true;
      }
      const outputs: vscode.NotebookCellOutput[] = [];
      let failed = false;
      for (const summary of checked.outcome.results) {
        if (summary.error !== undefined) {
          failed = true;
          outputs.push(errorOutput(summary.error.message));
        } else if (summary.columns.length > 0) {
          const window = this.deps.results.window(summary.id, 0, NOTEBOOK_ROW_LIMIT);
          const table = tableOutput(summary, window?.rows ?? []);
          outputs.push(
            new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.text(table.html, 'text/html'),
              vscode.NotebookCellOutputItem.text(table.text, 'text/plain'),
            ]),
          );
        } else {
          outputs.push(
            new vscode.NotebookCellOutput([
              vscode.NotebookCellOutputItem.stdout(doneLine(summary)),
            ]),
          );
        }
      }
      await execution.replaceOutput(outputs);
      success = !failed && !checked.outcome.cancelled;
      return !success;
    } catch (error) {
      this.deps.logger.warn('A notebook cell failed to run', error);
      await execution.replaceOutput(
        errorOutput(error instanceof Error ? error.message : String(error)),
      );
      return true;
    } finally {
      cancellation.dispose();
      // The rows were copied into the outputs; keeping them would only hold memory.
      this.deps.results.clearDocument(documentUri);
      execution.end(success, Date.now());
    }
  }
}

function errorOutput(message: string): vscode.NotebookCellOutput {
  return new vscode.NotebookCellOutput([
    vscode.NotebookCellOutputItem.error({ name: vscode.l10n.t('Error'), message }),
  ]);
}
