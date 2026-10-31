// Where the next page of a table opens. A page that hands the user over to another page
// of the same table (the bar of a table: data, properties, ER diagram…) names its own
// editor column here; the next panel created takes it instead of its default, so the
// new page lands where the old one was and the old one can be closed (D116).

import type * as vscode from 'vscode';

let pending: vscode.ViewColumn | undefined;

export function hintColumn(column: vscode.ViewColumn | undefined): void {
  pending = column;
}

/** The column the next panel opens in, once: taking it clears it. */
export function takeColumnHint(): vscode.ViewColumn | undefined {
  const column = pending;
  pending = undefined;
  return column;
}

/** True while a hint waits for the panel that is to use it. */
export function hasColumnHint(): boolean {
  return pending !== undefined;
}

export function clearColumnHint(): void {
  pending = undefined;
}
