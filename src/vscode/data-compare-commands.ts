// "Compare Data…" (V8.4): the clicked table is the source; the target table may be in
// any SQL connection — another database, even another kind of database. When the
// tables share no key, the user picks the columns that identify a row.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import type { TableRef } from '../core/model/objects';
import { browseSession } from '../services/browse-session';
import { ConnectionManager } from '../services/connection-manager';
import type { ConnectionStore } from '../services/connection-store';
import type { MetadataCache } from '../services/metadata-cache';
import { type ColumnPair, pairColumns } from '../services/data-compare/column-pairs';
import { describeTarget, isSqlDriver } from '../shared/connection';
import { pickScope } from './connection-pick';
import { DataCompareModel, type DataCompareSide } from './panels/data-compare-model';
import { DataComparePanel } from './panels/data-compare-panel';
import { tableLabel } from './tree/compare-target';
import { isTreeNode, tableRefOf } from './tree/nodes';

export interface DataCompareCommandDeps {
  readonly extensionUri: vscode.Uri;
  readonly store: ConnectionStore;
  readonly manager: Pick<ConnectionManager, 'driverOf' | 'connect' | 'acquire' | 'release'>;
  readonly cache: MetadataCache;
  readonly openEditor: (
    binding: { connectionId: string; database?: string },
    sql: string,
  ) => Promise<unknown>;
  readonly logger: Logger;
}

let nextComparison = 0;

export function dataCompareCommandHandlers(deps: DataCompareCommandDeps): {
  compareData: (target?: unknown) => Promise<void>;
} {
  const side = async (
    connectionId: string,
    table: TableRef,
    owner: string,
  ): Promise<DataCompareSide> => {
    const driver = await deps.manager.driverOf(connectionId);
    const metadata = deps.cache.wrap(
      connectionId,
      (await browseSession(deps.manager, connectionId, table.database)).metadata,
    );
    const name = deps.store.get(connectionId)?.name ?? connectionId;
    const target =
      table.database === undefined ? { connectionId } : { connectionId, database: table.database };
    return {
      label: tableLabel(name, table),
      table,
      dialect: driver.dialect,
      driver: driver.id,
      structure: await metadata.describeTable(table),
      session: async () => await deps.manager.acquire(owner, target),
      release: async () => {
        await deps.manager.release(owner);
      },
    };
  };

  const compareData = async (clicked?: unknown): Promise<void> => {
    if (!isTreeNode(clicked) || clicked.kind !== 'table' || clicked.tableKind !== 'table') {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick a table in the DataNest view to compare its data'),
      );
      return;
    }
    const sourceTable = tableRefOf(clicked);
    const connections = deps.store.list().filter((config) => isSqlDriver(config.driver));
    const pickedConnection = await vscode.window.showQuickPick(
      connections.map((config) => ({
        label: config.name,
        description: describeTarget(config),
        id: config.id,
      })),
      { placeHolder: vscode.l10n.t('Pick the connection of the target table') },
    );
    if (pickedConnection === undefined) {
      return;
    }
    const scope = await pickScope(
      deps.manager,
      pickedConnection.id,
      undefined,
      vscode.l10n.t('Pick the schema of the target table'),
    );
    if (scope === undefined) {
      return;
    }
    const tables = (
      await (
        await browseSession(deps.manager, pickedConnection.id, scope.database)
      ).metadata.listTables(scope)
    ).filter((table) => table.kind === 'table');
    // The table of the same name first: comparing copies is the usual case.
    const ordered = [
      ...tables.filter((table) => table.name.toLowerCase() === sourceTable.name.toLowerCase()),
      ...tables.filter((table) => table.name.toLowerCase() !== sourceTable.name.toLowerCase()),
    ];
    const pickedTable = await vscode.window.showQuickPick(
      ordered.map((table) => table.name),
      { placeHolder: vscode.l10n.t('Pick the target table: the one a sync script would change') },
    );
    if (pickedTable === undefined) {
      return;
    }
    const targetTable: TableRef = { ...scope, name: pickedTable };
    if (
      pickedConnection.id === clicked.connectionId &&
      JSON.stringify(targetTable) === JSON.stringify(sourceTable)
    ) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('Pick another table to compare with'),
      );
      return;
    }
    const id = nextComparison++;
    const source = await side(
      clicked.connectionId,
      sourceTable,
      ConnectionManager.taskOwner(`data-compare-${id}-source`),
    );
    const target = await side(
      pickedConnection.id,
      targetTable,
      ConnectionManager.taskOwner(`data-compare-${id}-target`),
    );
    const plan = pairColumns(source.structure, target.structure);
    if (plan.pairs.length === 0) {
      void vscode.window.showWarningMessage(
        vscode.l10n.t('The tables have no columns of the same name'),
      );
      return;
    }
    const key = plan.key.length > 0 ? plan.key : await pickKey(plan.pairs);
    if (key === undefined) {
      return;
    }
    const keyNames = new Set(key.map((pair) => pair.source));
    const targetDriver = await deps.manager.driverOf(pickedConnection.id);
    DataComparePanel.show({
      extensionUri: deps.extensionUri,
      logger: deps.logger,
      key: JSON.stringify([clicked.connectionId, sourceTable, pickedConnection.id, targetTable]),
      title: vscode.l10n.t('Data: {0} → {1}', sourceTable.name, targetTable.name),
      model: new DataCompareModel({
        source,
        target,
        key,
        columns: plan.pairs.filter((pair) => !keyNames.has(pair.source)),
        sourceOnly: plan.sourceOnly,
        targetOnly: plan.targetOnly,
        transactions: targetDriver.capabilities.transactions,
      }),
      openScript: async (text) => {
        await deps.openEditor(
          targetTable.database === undefined
            ? { connectionId: pickedConnection.id }
            : { connectionId: pickedConnection.id, database: targetTable.database },
          text,
        );
      },
      barView: {
        target:
          sourceTable.database === undefined
            ? { connectionId: clicked.connectionId }
            : { connectionId: clicked.connectionId, database: sourceTable.database },
        table: sourceTable,
      },
    });
  };
  return { compareData };
}

async function pickKey(pairs: readonly ColumnPair[]): Promise<ColumnPair[] | undefined> {
  const picked = await vscode.window.showQuickPick(
    pairs.map((pair) => ({
      label: pair.source,
      ...(pair.target === pair.source ? {} : { description: pair.target }),
      pair,
    })),
    {
      canPickMany: true,
      placeHolder: vscode.l10n.t('The tables share no key: pick the columns that identify a row'),
    },
  );
  return picked === undefined || picked.length === 0 ? undefined : picked.map((item) => item.pair);
}
