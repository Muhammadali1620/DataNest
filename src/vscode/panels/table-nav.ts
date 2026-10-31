// Moves from one page of a table to another in place (D116): the bar of a table page
// names the target, the new page opens in the column of the old one and the old page is
// closed once the new one exists, so the user keeps one tab and the bar stays under the
// cursor. A target that was already open elsewhere, or a command the user cancelled,
// leaves the old page alone.

import * as vscode from 'vscode';
import { COMMAND_IDS } from '../command-ids';
import { clearColumnHint, hasColumnHint, hintColumn } from './column-hint';
import type { TableAction, TablePage } from '../../shared/table-actions';
import { type TableActionCall, tableActionCall, type TablePageView } from './table-action';

const SETTLE_MS = 1500;
const POLL_MS = 40;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs a bar action of a table page; the history is a quick pick and stays out of it. */
export async function navigateTable(
  origin: vscode.WebviewPanel,
  call: TableActionCall,
  dirty: boolean,
): Promise<void> {
  if (call.command === COMMAND_IDS.showHistory) {
    await vscode.commands.executeCommand(call.command, ...call.args);
    return;
  }
  if (dirty && !(await confirmLeave())) {
    return;
  }
  hintColumn(origin.viewColumn);
  try {
    await vscode.commands.executeCommand(call.command, ...call.args);
    // A handler may create its panel after it has returned; give it a moment.
    for (let waited = 0; hasColumnHint() && waited < SETTLE_MS; waited += POLL_MS) {
      await sleep(POLL_MS);
    }
    if (!hasColumnHint()) {
      origin.dispose();
    }
  } finally {
    clearColumnHint();
  }
}

async function confirmLeave(): Promise<boolean> {
  const leave = vscode.l10n.t('Leave');
  const answer = await vscode.window.showWarningMessage(
    vscode.l10n.t('This page has unsaved changes. Leave it and lose them?'),
    { modal: true },
    leave,
  );
  return answer === leave;
}

/**
 * The bar of a page was pressed: the button of the page itself does nothing, the others
 * take its place. A page without a table has no bar and never gets here.
 */
export function onTableNav(
  panel: vscode.WebviewPanel,
  current: TablePage,
  view: TablePageView | undefined,
  event: { readonly action: TableAction; readonly dirty: boolean },
): void {
  if (view === undefined || event.action === current) {
    return;
  }
  void navigateTable(panel, tableActionCall(event.action, view), event.dirty);
}
