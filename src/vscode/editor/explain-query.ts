// "Explain Plan" and "Explain Analyze" (V8.2): the statement under the cursor (or the
// first selected one) is explained on the editor's own session, and its plan opens
// beside the editor.

import * as vscode from 'vscode';
import type { Logger } from '../../core/logging/logger';
import { isReadOnlyStatement } from '../../core/sql/read-only';
import { type SqlStatement, statementsIn } from '../../core/sql/split';
import { syntaxOf } from '../../core/sql/tokenizer';
import type { ConnectionStore } from '../../services/connection-store';
import {
  canAnalyze,
  explainStatement,
  type PlanServer,
  planServerOf,
} from '../../services/explain/explain';
import type { QueryRunner } from '../../services/query-runner';
import { type DriverId, isSqlDriver } from '../../shared/connection';
import type { FilledStatements } from '../../services/query-variables';
import { QueryPlanModel } from '../panels/query-plan-model';
import { QueryPlanPanel } from '../panels/query-plan-panel';
import type { QueryEditors } from './query-editor';
import { SQL_LANGUAGE_ID } from './query-editor';

export interface ExplainQueryDeps {
  readonly extensionUri: vscode.Uri;
  readonly runner: QueryRunner;
  readonly editors: QueryEditors;
  readonly store: ConnectionStore;
  readonly logger: Logger;
  /** Asks for the values of query variables (V10.2.1); undefined when cancelled. */
  readonly fillVariables?: (
    statements: readonly SqlStatement[],
    connectionId: string,
    driver: DriverId | undefined,
  ) => Promise<FilledStatements | undefined>;
}

export function explainCommandHandlers(deps: ExplainQueryDeps): {
  explain: () => Promise<void>;
  explainAnalyze: () => Promise<void>;
} {
  /** Which server a connection talks to does not change while DataNest runs. */
  const servers = new Map<string, PlanServer>();

  const explain = async (analyze: boolean): Promise<void> => {
    const editor = vscode.window.activeTextEditor;
    if (editor?.document.languageId !== SQL_LANGUAGE_ID) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Open a SQL query first: DataNest: New Query'),
      );
      return;
    }
    const documentUri = editor.document.uri.toString();
    const target =
      deps.editors.bindings.get(documentUri) ?? (await deps.editors.selectConnection());
    if (target === undefined) {
      return;
    }
    const driver = deps.store.get(target.connectionId)?.driver;
    if (driver === undefined || !isSqlDriver(driver)) {
      return;
    }
    const { document, selection } = editor;
    const [written] = statementsIn(
      document.getText(),
      document.offsetAt(selection.start),
      document.offsetAt(selection.end),
      driver,
    );
    if (written === undefined) {
      void vscode.window.showInformationMessage(vscode.l10n.t('Nothing to explain'));
      return;
    }
    const filled = await deps.fillVariables?.([written], target.connectionId, driver);
    if (deps.fillVariables !== undefined && filled === undefined) {
      return;
    }
    const statement = filled?.statements[0] ?? written;
    const connectionName = deps.store.get(target.connectionId)?.name ?? target.connectionId;
    QueryPlanPanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      documentUri,
      statement: statement.text,
      analyze,
      cancel: async () => {
        await deps.runner.cancel(documentUri);
      },
      model: () =>
        new QueryPlanModel(
          {
            connectionName,
            cancelledText: vscode.l10n.t('Cancelled'),
            explain: async (sql, runIt) =>
              await deps.runner.exclusive(documentUri, target, async (session) => {
                const server =
                  servers.get(target.connectionId) ?? (await planServerOf(session, driver));
                servers.set(target.connectionId, server);
                const plan = await explainStatement(session, server, sql, runIt);
                return {
                  plan,
                  canAnalyze: canAnalyze(server) && isReadOnlyStatement(sql, syntaxOf(driver)),
                };
              }),
          },
          statement.text,
        ),
    });
  };

  return {
    explain: async () => {
      await explain(false);
    },
    explainAnalyze: async () => {
      await explain(true);
    },
  };
}
