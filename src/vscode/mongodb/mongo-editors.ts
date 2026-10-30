// MongoDB query editors (V7.7): documents of the `datanest-mongo` language bound to a
// connection and a database. Ctrl+Enter or the CodeLens above a statement runs it, and
// its result opens beside the editor on the documents page; `use other` moves the editor
// to another database. Each editor has a session of its own.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { splitShellStatements, statementAt } from '../../core/mongo/shell-statements';
import { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { listMongoDatabases } from '../../services/mongodb/catalog';
import type { RunOutcome } from '../../services/mongodb/shell-run';
import type { SafeMode } from '../../services/safe-mode';
import { policyOf } from '../../services/write-policy';
import { describeTarget } from '../../shared/connection';
import { DocumentBindings } from '../editor/document-bindings';
import { MongoDocumentsPanel } from '../panels/mongo-documents-panel';
import { MongoResultModel } from '../panels/mongo-result-model';
import { isTreeNode } from '../tree/nodes';
import { mongoTreeSession } from '../tree/mongo-tree';
import {
  parseInDocument,
  type MongoRunQuestion,
  queryTemplate,
  runMongoStatement,
} from './mongo-run';
import { formatCount } from '../../core/number-format';

export const MONGO_LANGUAGE_ID = 'datanest-mongo';

export interface MongoEditorsDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly manager: ConnectionManager;
  readonly store: ConnectionStore;
  readonly safeMode: () => SafeMode;
  /** Milliseconds a read may take, for a connection. */
  readonly maxTimeMS: (connectionId: string) => number;
}

/** A statement to run by its offsets, as the CodeLens passes it. */
interface StatementRange {
  readonly uri: string;
  readonly start: number;
  readonly end: number;
}

function isRange(value: unknown): value is StatementRange {
  const range = value as Partial<StatementRange> | null;
  return (
    typeof range === 'object' &&
    range !== null &&
    typeof range.uri === 'string' &&
    typeof range.start === 'number' &&
    typeof range.end === 'number'
  );
}

export class MongoEditors implements vscode.Disposable, vscode.CodeLensProvider {
  private readonly bindings = new DocumentBindings();
  private readonly status: vscode.StatusBarItem;
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: MongoEditorsDeps) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.status.command = 'datanest.mongo.pickDatabase';
    this.subscriptions.push(
      this.status,
      this.lensesChanged,
      vscode.languages.registerCodeLensProvider({ language: MONGO_LANGUAGE_ID }, this),
      vscode.window.onDidChangeActiveTextEditor(() => {
        this.showStatus();
      }),
      vscode.workspace.onDidCloseTextDocument((document) => {
        const uri = document.uri.toString();
        this.bindings.unbind(uri);
        void deps.manager.release(ConnectionManager.editorOwner(uri));
      }),
      this.bindings.onDidChange(() => {
        this.showStatus();
      }),
    );
    this.showStatus();
  }

  dispose(): void {
    for (const subscription of this.subscriptions.splice(0).reverse()) {
      subscription.dispose();
    }
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const uri = document.uri.toString();
    return splitShellStatements(document.getText()).map((statement) => {
      const start = document.positionAt(statement.start);
      return new vscode.CodeLens(new vscode.Range(start, start), {
        title: vscode.l10n.t('▶ Run'),
        command: 'datanest.mongo.runStatement',
        arguments: [{ uri, start: statement.start, end: statement.end } satisfies StatementRange],
      });
    });
  }

  /** Opens a new query on the clicked connection, database or collection. */
  async newQuery(target?: unknown): Promise<void> {
    const node = isTreeNode(target) ? target : undefined;
    const connectionId =
      node !== undefined && 'connectionId' in node
        ? node.connectionId
        : await this.pickConnection();
    if (connectionId === undefined) {
      return;
    }
    const database =
      node?.kind === 'mongoDatabase' ||
      node?.kind === 'mongoCollection' ||
      node?.kind === 'mongoIndex'
        ? node.database
        : this.defaultDatabase(connectionId);
    const document = await vscode.workspace.openTextDocument({
      language: MONGO_LANGUAGE_ID,
      content: queryTemplate(node),
    });
    this.bindings.bind(document.uri.toString(), { connectionId, database });
    await vscode.window.showTextDocument(document);
  }

  /** Runs the selection, or the statement at the cursor (Ctrl+Enter). */
  async runAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== MONGO_LANGUAGE_ID) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a MongoDB query first: DataNest: New MongoDB Query'),
      );
      return;
    }
    const { document, selection } = editor;
    const text = document.getText();
    if (!selection.isEmpty) {
      const start = document.offsetAt(selection.start);
      await this.run(document, start, document.getText(selection));
      return;
    }
    const statement = statementAt(text, document.offsetAt(selection.active));
    if (statement === undefined) {
      void vscode.window.showInformationMessage(vscode.l10n.t('There is no statement here'));
      return;
    }
    await this.run(document, statement.start, statement.text);
  }

  /** Runs one statement by its offsets (the CodeLens). */
  async runStatement(range?: unknown): Promise<void> {
    if (!isRange(range)) {
      return;
    }
    const document = vscode.workspace.textDocuments.find((one) => one.uri.toString() === range.uri);
    if (document === undefined) {
      return;
    }
    const text = document.getText();
    await this.run(document, range.start, text.slice(range.start, range.end));
  }

  /** Points the active editor at another connection or database (the status bar). */
  async pickDatabase(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== MONGO_LANGUAGE_ID) {
      return;
    }
    const connectionId = await this.pickConnection();
    if (connectionId === undefined) {
      return;
    }
    const session = await mongoTreeSession(this.deps.manager, connectionId);
    const databases = await listMongoDatabases(
      session,
      this.deps.store.get(connectionId)?.database,
    );
    const picked = await vscode.window.showQuickPick(
      databases.map((database) => database.name),
      { placeHolder: vscode.l10n.t('Pick a database; `use <name>` in the editor does the same') },
    );
    if (picked !== undefined) {
      this.bindings.bind(editor.document.uri.toString(), { connectionId, database: picked });
    }
  }

  /** The database a new editor of a connection starts in: the one it names, else `test`. */
  private defaultDatabase(connectionId: string): string {
    const named = this.deps.store.get(connectionId)?.database?.trim();
    return named === undefined || named === '' ? 'test' : named;
  }

  private async pickConnection(): Promise<string | undefined> {
    const mongo = this.deps.store.list().filter((config) => config.driver === 'mongodb');
    if (mongo.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('There is no MongoDB connection yet'),
      );
      return undefined;
    }
    if (mongo.length === 1) {
      return mongo[0]?.id;
    }
    const chosen = await vscode.window.showQuickPick(
      mongo.map((config) => ({
        label: config.name,
        description: describeTarget(config),
        id: config.id,
      })),
      { placeHolder: vscode.l10n.t('Pick a MongoDB connection') },
    );
    return chosen?.id;
  }

  private async run(document: vscode.TextDocument, offset: number, text: string): Promise<void> {
    const uri = document.uri.toString();
    let binding = this.bindings.get(uri);
    if (binding === undefined) {
      const connectionId = await this.pickConnection();
      if (connectionId === undefined) {
        return;
      }
      binding = {
        connectionId,
        database: this.defaultDatabase(connectionId),
      };
      this.bindings.bind(uri, binding);
    }
    const config = this.deps.store.get(binding.connectionId);
    if (config === undefined) {
      this.bindings.unbind(uri);
      return;
    }
    const database = binding.database ?? 'test';
    const statement = parseInDocument(document.getText(), offset, text);
    const policy = policyOf(config);
    const result = await runMongoStatement(
      {
        session: async () =>
          await this.deps.manager.acquireMongo(ConnectionManager.editorOwner(uri), {
            connectionId: binding.connectionId,
          }),
        policy,
        safeMode: this.deps.safeMode(),
        maxTimeMS: this.deps.maxTimeMS(binding.connectionId),
        ask: async (question) => await this.ask(question, policy.name),
        texts: {
          readOnly: vscode.l10n.t('The connection is read-only: nothing may change'),
          blocked: vscode.l10n.t(
            'Safe mode blocks statements that drop data or change every document; turn datanest.safeMode to "confirm" to run them after a question',
          ),
        },
      },
      database,
      statement,
      text,
    );
    if (result.kind === 'cancelled') {
      return;
    }
    if (result.outcome.kind === 'use') {
      this.bindings.bind(uri, {
        connectionId: binding.connectionId,
        database: result.outcome.database,
      });
      void vscode.window.setStatusBarMessage(
        vscode.l10n.t('Switched to the database {0}', result.outcome.database),
        3000,
      );
      return;
    }
    const model = await MongoResultModel.open({
      connectionName: config.name,
      database: result.database,
      statement: text,
      outcome: result.outcome,
      tookMs: result.tookMs,
      texts: {
        count: (count) => vscode.l10n.t('{0} documents', count),
        write: (outcome) => writeSummary(outcome),
        capped: (count) =>
          vscode.l10n.t(
            'The first {0} documents are shown',
            formatCount(count, vscode.env.language),
          ),
      },
    });
    MongoDocumentsPanel.show({
      extensionUri: this.deps.extensionUri,
      logger: this.deps.logger,
      connectionId: binding.connectionId,
      database: result.database,
      collection: model.collection,
      model,
      policy,
      results: {
        key: uri,
        title: vscode.l10n.t('Result: {0}', document.uri.path.split('/').pop() ?? ''),
      },
    });
  }

  private async ask(question: MongoRunQuestion, connection: string): Promise<boolean> {
    const go = vscode.l10n.t('Run');
    const short =
      question.statement.length > 200 ? `${question.statement.slice(0, 197)}…` : question.statement;
    const message =
      question.kind === 'dangerous'
        ? vscode.l10n.t('Run this? It drops data or changes every document.')
        : vscode.l10n.t('Run this on the production connection "{0}"?', connection);
    const detail = [
      short,
      ...(question.kind === 'dangerous' && question.production
        ? [vscode.l10n.t('"{0}" is a production connection.', connection)]
        : []),
    ].join('\n\n');
    return (await vscode.window.showWarningMessage(message, { modal: true, detail }, go)) === go;
  }

  private showStatus(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== MONGO_LANGUAGE_ID) {
      this.status.hide();
      return;
    }
    const binding = this.bindings.get(editor.document.uri.toString());
    const config = binding === undefined ? undefined : this.deps.store.get(binding.connectionId);
    this.status.text =
      binding === undefined || config === undefined
        ? vscode.l10n.t('$(plug) MongoDB: no connection')
        : `$(database) ${config.name} › ${binding.database ?? ''}`;
    this.status.tooltip = vscode.l10n.t('The connection and database this MongoDB query runs in');
    this.status.show();
  }
}

/** "Inserted 2 documents", "Matched 3, modified 2", "Deleted 1 document". */
export function writeSummary(outcome: Extract<RunOutcome, { kind: 'write' }>): string {
  if (outcome.inserted !== undefined) {
    return vscode.l10n.t('Inserted: {0}', outcome.inserted);
  }
  if (outcome.deleted !== undefined) {
    return vscode.l10n.t('Deleted: {0}', outcome.deleted);
  }
  return outcome.upserted !== undefined && outcome.upserted > 0
    ? vscode.l10n.t(
        'Matched: {0}, modified: {1}, inserted by upsert: {2}',
        outcome.matched ?? 0,
        outcome.modified ?? 0,
        outcome.upserted,
      )
    : vscode.l10n.t('Matched: {0}, modified: {1}', outcome.matched ?? 0, outcome.modified ?? 0);
}
