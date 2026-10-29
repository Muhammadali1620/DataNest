// "Find Database Object…": one list of every table, view, routine, sequence and
// event of the connected connections, filled in as each connection answers.
// Connections that are not connected can be searched with one more click.

import * as vscode from 'vscode';
import { errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ObjectRef } from '../../core/model/objects';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { isSqlDriver } from '../../shared/connection';
import {
  type IndexedObject,
  indexConnection,
  type ObjectIndexDeps,
} from '../../services/object-index';
import type { TableNode } from '../tree/nodes';
import {
  compareObjects,
  defaultAction,
  definitionRef,
  objectDescription,
  objectLabel,
} from './object-items';

export interface ObjectSearchDeps extends ObjectIndexDeps {
  readonly manager: ObjectIndexDeps['manager'] &
    Pick<ConnectionManager, 'connect' | 'connectedIds'>;
  readonly store: Pick<ConnectionStore, 'get' | 'list'>;
  readonly openTable: (node: TableNode) => Promise<void>;
  readonly showDefinition: (connectionId: string, object: ObjectRef) => Promise<void>;
  readonly logger: Logger;
}

interface SearchItem extends vscode.QuickPickItem {
  readonly object?: IndexedObject;
  /** A connection to connect and search when chosen. */
  readonly connect?: string;
}

const DDL = { iconPath: new vscode.ThemeIcon('file-code'), tooltip: vscode.l10n.t('Show DDL') };
const COPY = { iconPath: new vscode.ThemeIcon('copy'), tooltip: vscode.l10n.t('Copy Name') };

export function showObjectSearch(deps: ObjectSearchDeps): void {
  const picker = vscode.window.createQuickPick<SearchItem>();
  picker.title = vscode.l10n.t('Find Database Object');
  picker.placeholder = vscode.l10n.t(
    'Type a name: tables, views, functions… of connected databases',
  );
  picker.matchOnDescription = true;
  const nameOf = (id: string): string => deps.store.get(id)?.name ?? id;
  const objects: IndexedObject[] = [];
  const problems = new Map<string, string>();
  const searched = new Set<string>();
  let pending = 0;

  const render = (): void => {
    const sorted = [...objects].sort((a, b) => compareObjects(a, b, nameOf));
    const items: SearchItem[] = sorted.map((object) => ({
      label: objectLabel(object),
      description: objectDescription(object, nameOf(object.connectionId)),
      buttons: [DDL, COPY],
      object,
    }));
    for (const [connectionId, message] of problems) {
      items.push({ label: `$(error) ${nameOf(connectionId)}`, detail: message, alwaysShow: true });
    }
    // Redis has keys, not tables: the object search is for SQL connections (D81).
    const others = deps.store
      .list()
      .filter((config) => isSqlDriver(config.driver) && !searched.has(config.id));
    if (others.length > 0) {
      items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
      for (const config of others) {
        items.push({
          label: vscode.l10n.t('$(plug) Connect to {0} and search it', config.name),
          alwaysShow: true,
          connect: config.id,
        });
      }
    }
    picker.items = items;
    picker.busy = pending > 0;
  };

  const search = async (connectionId: string): Promise<void> => {
    searched.add(connectionId);
    pending += 1;
    render();
    try {
      objects.push(...(await indexConnection(deps, connectionId)));
      problems.delete(connectionId);
    } catch (error) {
      deps.logger.warn(`Could not search ${connectionId}`, error);
      problems.set(connectionId, errorMessage(error));
    } finally {
      pending -= 1;
      render();
    }
  };

  const act = async (item: SearchItem): Promise<void> => {
    if (item.connect !== undefined) {
      await deps.manager.connect(item.connect);
      await search(item.connect);
      return;
    }
    const object = item.object;
    if (object === undefined) {
      return;
    }
    picker.hide();
    const action = defaultAction(object);
    if (action.kind === 'open-table') {
      await deps.openTable(action.node);
    } else {
      await deps.showDefinition(object.connectionId, action.object);
    }
  };

  const guard = (work: () => Promise<void>): void => {
    work().catch((error: unknown) => {
      deps.logger.warn('Object search action failed', error);
      void vscode.window.showErrorMessage(vscode.l10n.t('DataNest: {0}', errorMessage(error)));
    });
  };

  picker.onDidAccept(() => {
    const [item] = picker.selectedItems;
    if (item !== undefined) {
      guard(async () => {
        await act(item);
      });
    }
  });
  picker.onDidTriggerItemButton(({ item, button }) => {
    const object = item.object;
    if (object === undefined) {
      return;
    }
    if (button === COPY) {
      guard(async () => {
        await vscode.env.clipboard.writeText(object.name);
      });
      return;
    }
    picker.hide();
    guard(async () => {
      await deps.showDefinition(object.connectionId, definitionRef(object));
    });
  });
  picker.onDidHide(() => {
    picker.dispose();
  });
  render();
  picker.show();
  for (const connectionId of deps.manager.connectedIds()) {
    const driver = deps.store.get(connectionId)?.driver;
    if (driver !== undefined && isSqlDriver(driver)) {
      void search(connectionId);
    }
  }
}
