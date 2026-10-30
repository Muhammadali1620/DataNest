// "Chart of Result" (V8.7): from the result grid's button or the palette, a chart of the
// result shown beside the SQL editor, drawn from a copy of its rows.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { ResultStore } from '../services/result-store';
import { tabTitle } from '../shared/protocols/result-grid';
import { ResultChartModel } from './panels/result-chart-model';
import { ResultChartPanel } from './panels/result-chart-panel';

export interface ChartCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly results: Pick<ResultStore, 'get' | 'allRows'>;
  readonly logger: Logger;
}

export function chartCommandHandlers(deps: ChartCommandDeps): {
  chartResult: (resultId: string) => void;
} {
  const chartResult = (resultId: string): void => {
    const summary = deps.results.get(resultId);
    const rows = deps.results.allRows(resultId);
    if (summary === undefined || rows === undefined) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('The result is gone; run the query again to chart it'),
      );
      return;
    }
    if (summary.error !== undefined || summary.columns.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('The statement returned no rows to chart'),
      );
      return;
    }
    ResultChartPanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      key: resultId,
      title: vscode.l10n.t('Chart: {0}', tabTitle(summary.statement, 30)),
      model: new ResultChartModel({
        statement: summary.statement,
        columns: summary.columns,
        rows,
        truncated: summary.truncated,
      }),
    });
  };
  return { chartResult };
}
