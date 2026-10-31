// Moves from one page of a table to another inside one editor tab (D117): the bar of a
// table page names the target, the page offers its tab and the target page loads its
// content into that very tab. Nothing closes or moves, and the old page keeps working
// until the new one is ready to appear. A target that is already open in another tab, or
// a command the user cancelled, leaves the old page alone.

import * as vscode from 'vscode';
import { COMMAND_IDS } from '../command-ids';
import { clearOffer, offerPanel } from './panel-handoff';
import type { TableAction, TablePage } from '../../shared/table-actions';
import {
  TABLE_PAGE_APPS,
  type TableActionCall,
  tableActionCall,
  type TablePageView,
} from './table-action';

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
  if (call.page !== undefined) {
    offerPanel(origin, TABLE_PAGE_APPS[call.page], {
      page: call.page,
      isView: call.isView === true,
    });
  }
  try {
    await vscode.commands.executeCommand(call.command, ...call.args);
  } finally {
    // Nobody took the tab (the page was already open elsewhere): the old page stays.
    clearOffer();
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
