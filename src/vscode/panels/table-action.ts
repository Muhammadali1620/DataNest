// Turns a click on the table bar of a result into the command the tree would run, with
// the table's tree node as its argument. Free of `vscode`, so the mapping is unit tested.

import type { TableRef } from '../../core/model/objects';
import type { SessionTarget } from '../../services/connection-manager';
import type { TableAction } from '../../shared/table-actions';
import { COMMAND_IDS } from '../command-ids';
import type { TreeNode } from '../tree/nodes';

const COMMANDS: Readonly<Record<TableAction, string>> = {
  properties: COMMAND_IDS.designTable,
  ddl: COMMAND_IDS.showDefinition,
  er: COMMAND_IDS.showErDiagram,
  generate: COMMAND_IDS.generateData,
  compare: COMMAND_IDS.compareData,
  history: COMMAND_IDS.showHistory,
  dump: COMMAND_IDS.dumpSql,
  transfer: COMMAND_IDS.transferTables,
};

/** The tree node of the table a table view shows, as the tree commands expect it. */
export function tableNodeOf(view: { target: SessionTarget; table: TableRef }): TreeNode {
  const database = view.table.database ?? view.target.database;
  return {
    kind: 'table',
    connectionId: view.target.connectionId,
    scope: {
      ...(database === undefined ? {} : { database }),
      ...(view.table.schema === undefined ? {} : { schema: view.table.schema }),
    },
    name: view.table.name,
    tableKind: 'table',
  };
}

export interface TableActionCall {
  readonly command: string;
  readonly args: readonly unknown[];
}

/** The command to run for a bar action; the history is filtered to the table instead. */
export function tableActionCall(
  action: TableAction,
  view: { target: SessionTarget; table: TableRef },
): TableActionCall {
  if (action === 'history') {
    return {
      command: COMMANDS.history,
      args: [{ connectionId: view.target.connectionId, table: view.table.name }],
    };
  }
  return { command: COMMANDS[action], args: [tableNodeOf(view)] };
}
