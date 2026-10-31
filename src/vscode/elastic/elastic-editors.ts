// Elasticsearch query editors (V7.8): documents of the `datanest-es` language bound to a
// connection, with requests written as consoles write them. Ctrl+Enter or the CodeLens
// above a request sends it; its answer opens beside the editor.

import * as vscode from 'vscode';
import {
  type ParsedRequest,
  parseRequest,
  requestAt,
  RequestSyntaxError,
  splitRequests,
} from '../../core/elastic/requests';
import { curlCommand } from '../../services/elasticsearch/curl';
import { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { resultState } from '../../services/elasticsearch/result-view';
import type { SafeMode } from '../../services/safe-mode';
import { policyOf } from '../../services/write-policy';
import { describeTarget } from '../../shared/connection';
import { DocumentBindings } from '../editor/document-bindings';
import type { Logger } from '../../core/logging/logger';
import { ElasticResultPanel } from '../panels/elastic-result-panel';
import { isTreeNode } from '../tree/nodes';
import {
  type ElasticRunQuestion,
  parseInDocument,
  requestTemplate,
  runElasticRequest,
} from './elastic-run';

export const ELASTIC_LANGUAGE_ID = 'datanest-es';

export interface ElasticEditorsDeps {
  readonly extensionUri: vscode.Uri;
  readonly logger: Logger;
  readonly manager: ConnectionManager;
  readonly store: ConnectionStore;
  readonly safeMode: () => SafeMode;
  /** Milliseconds a request may take, for a connection. */
  readonly timeoutMs: (connectionId: string) => number;
}

interface RequestRange {
  readonly uri: string;
  readonly start: number;
}

function isRange(value: unknown): value is RequestRange {
  const range = value as Partial<RequestRange> | null;
  return (
    typeof range === 'object' &&
    range !== null &&
    typeof range.uri === 'string' &&
    typeof range.start === 'number'
  );
}

export class ElasticEditors implements vscode.Disposable, vscode.CodeLensProvider {
  private readonly bindings = new DocumentBindings();
  private readonly status: vscode.StatusBarItem;
  private readonly lensesChanged = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensesChanged.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly deps: ElasticEditorsDeps) {
    this.status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 90);
    this.status.command = 'datanest.elastic.pickConnection';
    this.subscriptions.push(
      this.status,
      this.lensesChanged,
      vscode.languages.registerCodeLensProvider({ language: ELASTIC_LANGUAGE_ID }, this),
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
    return splitRequests(document.getText()).map((request) => {
      const start = document.positionAt(request.start);
      return new vscode.CodeLens(new vscode.Range(start, start), {
        title: vscode.l10n.t('▶ Send'),
        command: 'datanest.elastic.runRequest',
        arguments: [{ uri, start: request.start } satisfies RequestRange],
      });
    });
  }

  async newQuery(target?: unknown): Promise<void> {
    const node = isTreeNode(target) ? target : undefined;
    const connectionId =
      node !== undefined && 'connectionId' in node
        ? node.connectionId
        : await this.pickConnectionId();
    if (connectionId === undefined) {
      return;
    }
    const index =
      node?.kind === 'elasticIndex'
        ? node.index.name
        : node?.kind === 'elasticField'
          ? node.index
          : undefined;
    const document = await vscode.workspace.openTextDocument({
      language: ELASTIC_LANGUAGE_ID,
      content: requestTemplate(index),
    });
    this.bindings.bind(document.uri.toString(), { connectionId });
    await vscode.window.showTextDocument(document);
  }

  /** Sends the request at the cursor (Ctrl+Enter). */
  async runAtCursor(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== ELASTIC_LANGUAGE_ID) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open an Elasticsearch query first: DataNest: New Elasticsearch Query'),
      );
      return;
    }
    await this.run(editor.document, editor.document.offsetAt(editor.selection.active));
  }

  /** Sends one request by where it starts (the CodeLens). */
  async runRequest(range?: unknown): Promise<void> {
    if (!isRange(range)) {
      return;
    }
    const document = vscode.workspace.textDocuments.find((one) => one.uri.toString() === range.uri);
    if (document !== undefined) {
      await this.run(document, range.start);
    }
  }

  /** Points the active editor at another connection (the status bar). */
  async pickConnection(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== ELASTIC_LANGUAGE_ID) {
      return;
    }
    const connectionId = await this.pickConnectionId(true);
    if (connectionId !== undefined) {
      this.bindings.bind(editor.document.uri.toString(), { connectionId });
    }
  }

  private async pickConnectionId(always = false): Promise<string | undefined> {
    const elastic = this.deps.store.list().filter((config) => config.driver === 'elasticsearch');
    if (elastic.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('There is no Elasticsearch connection yet'),
      );
      return undefined;
    }
    if (elastic.length === 1 && !always) {
      return elastic[0]?.id;
    }
    const chosen = await vscode.window.showQuickPick(
      elastic.map((config) => ({
        label: config.name,
        description: describeTarget(config),
        id: config.id,
      })),
      { placeHolder: vscode.l10n.t('Pick an Elasticsearch connection') },
    );
    return chosen?.id;
  }

  /** "Copy as cURL" (V10.2.7): the request under the cursor, for a shell. */
  async copyAsCurl(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== ELASTIC_LANGUAGE_ID) {
      return;
    }
    const text = editor.document.getText();
    const found = requestAt(text, editor.document.offsetAt(editor.selection.active));
    if (found === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'There is no request here: a request starts with GET, POST, PUT or DELETE and a path',
        ),
      );
      return;
    }
    const uri = editor.document.uri.toString();
    const connectionId = this.bindings.get(uri)?.connectionId ?? (await this.pickConnectionId());
    const config = connectionId === undefined ? undefined : this.deps.store.get(connectionId);
    if (config === undefined) {
      return;
    }
    let request: ParsedRequest;
    try {
      request = parseRequest(found, text);
    } catch (error) {
      if (error instanceof RequestSyntaxError) {
        void vscode.window.showErrorMessage(error.message);
        return;
      }
      throw error;
    }
    await vscode.env.clipboard.writeText(curlCommand(request, config));
    void vscode.window.showInformationMessage(
      config.elastic?.auth === 'apiKey'
        ? vscode.l10n.t('Copied as cURL. Put the API key in ELASTIC_API_KEY before running it.')
        : vscode.l10n.t('Copied as cURL. curl asks for the password when it runs.'),
    );
  }

  private async run(document: vscode.TextDocument, offset: number): Promise<void> {
    const text = document.getText();
    const found = requestAt(text, offset);
    if (found === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          'There is no request here: a request starts with GET, POST, PUT or DELETE and a path',
        ),
      );
      return;
    }
    const uri = document.uri.toString();
    let binding = this.bindings.get(uri);
    if (binding === undefined) {
      const connectionId = await this.pickConnectionId();
      if (connectionId === undefined) {
        return;
      }
      binding = { connectionId };
      this.bindings.bind(uri, binding);
    }
    const config = this.deps.store.get(binding.connectionId);
    if (config === undefined) {
      this.bindings.unbind(uri);
      return;
    }
    const request = parseInDocument(found, text);
    const policy = policyOf(config);
    const connectionId = binding.connectionId;
    const result = await runElasticRequest(
      {
        session: async () =>
          await this.deps.manager.acquireElastic(ConnectionManager.editorOwner(uri), {
            connectionId,
          }),
        policy,
        safeMode: this.deps.safeMode(),
        timeoutMs: this.deps.timeoutMs(connectionId),
        ask: async (question) => await this.ask(question, policy.name),
        texts: {
          readOnly: vscode.l10n.t('The connection is read-only: nothing may change'),
          blocked: vscode.l10n.t(
            'Safe mode blocks requests that delete indices or every document; turn datanest.safeMode to "confirm" to send them after a question',
          ),
        },
      },
      request,
    );
    if (result.kind === 'cancelled') {
      return;
    }
    const state = resultState({
      connectionName: config.name,
      request: `${request.method} ${request.path}`,
      response: result.response,
      tookMs: result.tookMs,
    });
    ElasticResultPanel.show({
      extensionUri: this.deps.extensionUri,
      logger: this.deps.logger,
      key: uri,
      title: vscode.l10n.t('Answer: {0}', document.uri.path.split('/').pop() ?? ''),
      state,
      copyText: (rows) =>
        rows === undefined || rows.length === 0
          ? state.text
          : rows.map((row) => state.rows[row]?.text ?? '').join('\n'),
    });
  }

  private async ask(question: ElasticRunQuestion, connection: string): Promise<boolean> {
    const go = vscode.l10n.t('Send');
    const message =
      question.kind === 'dangerous'
        ? vscode.l10n.t(
            'Send {0}? It deletes indices or every document it matches.',
            question.request,
          )
        : vscode.l10n.t(
            'Send {0} to the production connection "{1}"?',
            question.request,
            connection,
          );
    const detail =
      question.kind === 'dangerous' && question.production
        ? vscode.l10n.t('"{0}" is a production connection.', connection)
        : undefined;
    return (
      (await vscode.window.showWarningMessage(
        message,
        { modal: true, ...(detail === undefined ? {} : { detail }) },
        go,
      )) === go
    );
  }

  private showStatus(): void {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== ELASTIC_LANGUAGE_ID) {
      this.status.hide();
      return;
    }
    const binding = this.bindings.get(editor.document.uri.toString());
    const config = binding === undefined ? undefined : this.deps.store.get(binding.connectionId);
    this.status.text =
      config === undefined
        ? vscode.l10n.t('$(plug) Elasticsearch: no connection')
        : `$(search) ${config.name}`;
    this.status.tooltip = vscode.l10n.t('The connection this Elasticsearch query is sent to');
    this.status.show();
  }
}
