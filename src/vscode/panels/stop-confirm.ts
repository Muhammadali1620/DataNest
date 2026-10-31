// The question before a statement or session of another client is stopped; shared by
// the server monitor page and the Manager page's ProcessList.

import * as vscode from 'vscode';
import type { ServerProcess, StopKind } from '../../services/monitor/processes';

/** How much of a statement the question quotes. */
const QUOTED_QUERY = 300;

export async function confirmStop(
  process: ServerProcess,
  kind: StopKind,
  connection: { name: string; production: boolean },
): Promise<boolean> {
  const who = [process.user, process.host, process.database]
    .filter((part) => part !== undefined)
    .join(' · ');
  const query =
    process.query === undefined
      ? ''
      : process.query.length > QUOTED_QUERY
        ? `${process.query.slice(0, QUOTED_QUERY)}…`
        : process.query;
  const action =
    kind === 'cancel' ? vscode.l10n.t('Cancel Statement') : vscode.l10n.t('End Session');
  const detail = [
    who,
    query,
    connection.production
      ? vscode.l10n.t('"{0}" is a production connection.', connection.name)
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n\n');
  const answer = await vscode.window.showWarningMessage(
    kind === 'cancel'
      ? vscode.l10n.t('Cancel the statement of process {0}?', process.id)
      : vscode.l10n.t('End the session of process {0}?', process.id),
    { modal: true, detail },
    action,
  );
  return answer === action;
}
