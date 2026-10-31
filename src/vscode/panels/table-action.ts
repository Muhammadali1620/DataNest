// Turns a click on the table bar of a result into the command the tree would run, with
// the table's tree node as its argument. Free of `vscode`, so the mapping is unit tested.

import type { TableRef } from '../../core/model/objects';
import type { SessionTarget } from '../../services/connection-manager';
import type { TableAction, TablePage } from '../../shared/table-actions';
import { COMMAND_IDS } from '../command-ids';
import type { TableNode } from '../tree/nodes';

/** The Manager page of the table's database (log, dashboard, processes, dump, sync). */
export const MANAGER_COMMAND = 'datanest.manager.open';

const COMMANDS: Readonly<Record<Exclude<TableAction, 'manager'>, string>> = {
  properties: COMMAND_IDS.designTable,
  data: COMMAND_IDS.openTable,
  er: COMMAND_IDS.showErDiagram,
  generate: COMMAND_IDS.generateData,
  compare: COMMAND_IDS.compareData,
  history: COMMAND_IDS.showHistory,
};

/** The tree node of the table a table view shows, as the tree commands expect it. */
export function tableNodeOf(view: {
  target: SessionTarget;
  table: TableRef;
  kind?: 'table' | 'view';
}): TableNode {
  const database = view.table.database ?? view.target.database;
  return {
    kind: 'table',
    connectionId: view.target.connectionId,
    scope: {
      ...(database === undefined ? {} : { database }),
      ...(view.table.schema === undefined ? {} : { schema: view.table.schema }),
    },
    name: view.table.name,
    tableKind: view.kind ?? 'table',
  };
}

/** What a page needs to know about its table to answer the bar. */
export interface TablePageView {
  readonly target: SessionTarget;
  readonly table: TableRef;
  readonly kind?: 'table' | 'view';
}

/** The webview app that shows each page of a table. */
export const TABLE_PAGE_APPS: Readonly<Record<TablePage, string>> = {
  properties: 'table-designer',
  data: 'result-grid',
  er: 'er-diagram',
  generate: 'test-data',
  compare: 'data-compare',
  manager: 'manager',
};

export interface TableActionCall {
  readonly command: string;
  readonly args: readonly unknown[];
  /** The page of the table the command opens; absent for the history. */
  readonly page?: TablePage;
  readonly isView?: boolean;
}

/** The command to run for a bar action; the history is filtered to the table instead. */
export function tableActionCall(
  action: TableAction,
  view: { target: SessionTarget; table: TableRef; kind?: 'table' | 'view' },
): TableActionCall {
  if (action === 'history') {
    return {
      command: COMMANDS.history,
      args: [{ connectionId: view.target.connectionId, table: view.table.name }],
    };
  }
  if (action === 'manager') {
    const node = tableNodeOf(view);
    return {
      command: MANAGER_COMMAND,
      args: [
        {
          connectionId: node.connectionId,
          scope: node.scope,
          table: { name: node.name, kind: view.kind ?? 'table' },
        },
      ],
      page: 'manager',
      isView: view.kind === 'view',
    };
  }
  // A view's "Properties" is its definition editor; the designer is for tables.
  const command =
    action === 'properties' && view.kind === 'view' ? COMMAND_IDS.editObject : COMMANDS[action];
  return { command, args: [tableNodeOf(view)], page: action, isView: view.kind === 'view' };
}
