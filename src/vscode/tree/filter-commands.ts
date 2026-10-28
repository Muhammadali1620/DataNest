import * as vscode from 'vscode';
import { DbError } from '../../core/errors';
import { parsePatterns } from '../../shared/name-filter';
import { withoutSystemDatabases, withoutSystemSchemas } from '../../core/model/system-objects';
import { browseSession } from '../../services/browse-session';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import type { MetadataCache } from '../../services/metadata-cache';
import type { ConnectionConfig } from '../../shared/connection';
import { type FilterKind, initiallyPicked, pickOutcome, withList } from './filter-pick';
import { connectionIdOf, isTreeNode } from './nodes';
import type { CommandTarget } from './tree-commands';
import type { TreeSettings } from './tree-model';

export interface FilterCommandDeps {
  readonly store: ConnectionStore;
  readonly manager: ConnectionManager;
  readonly cache: MetadataCache;
  readonly settings: TreeSettings;
}

type Kind = FilterKind;

/** "Filter Databases…" and "Filter Schemas…" of the tree (V4.10). */
export function filterCommandHandlers(deps: FilterCommandDeps): {
  filterDatabases: (target?: CommandTarget) => Promise<void>;
  filterSchemas: (target?: CommandTarget) => Promise<void>;
} {
  const configOf = (target: CommandTarget): ConnectionConfig => {
    const id = connectionIdOf(target);
    const config = id === undefined ? undefined : deps.store.get(id);
    if (config === undefined) {
      throw new DbError('not-found', vscode.l10n.t('Pick a connection in the DataNest view first'));
    }
    return config;
  };

  const metadataOf = async (connectionId: string, database?: string) =>
    deps.cache.wrap(
      connectionId,
      (await browseSession(deps.manager, connectionId, database)).metadata,
    );

  const filterDatabases = async (target?: CommandTarget): Promise<void> => {
    const config = configOf(target);
    const driver = await deps.manager.driverOf(config.id);
    if (!driver.capabilities.databases) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('This connection opens a single database file: there is nothing to filter'),
      );
      return;
    }
    const all = await (await metadataOf(config.id)).listDatabases();
    const names = deps.settings.showSystemObjects()
      ? all
      : withoutSystemDatabases(config.driver, all);
    await choose(deps.store, config, 'databases', names);
  };

  const filterSchemas = async (target?: CommandTarget): Promise<void> => {
    const config = configOf(target);
    const database =
      isTreeNode(target) && 'database' in target && typeof target.database === 'string'
        ? target.database
        : config.database;
    const all = await (await metadataOf(config.id, database)).listSchemas(database);
    const names = deps.settings.showSystemObjects()
      ? all
      : withoutSystemSchemas(config.driver, all);
    await choose(deps.store, config, 'schemas', names);
  };

  return { filterDatabases, filterSchemas };
}

interface NameItem extends vscode.QuickPickItem {
  readonly name: string;
}

/**
 * A list with every name ticked that the filter shows now. Ticking all removes the
 * filter; the title button switches to writing patterns, for `app_*` and `!x`.
 */
async function choose(
  store: ConnectionStore,
  config: ConnectionConfig,
  kind: Kind,
  names: readonly string[],
): Promise<void> {
  const current = config.filter?.[kind] ?? [];
  const items: NameItem[] = names.map((name) => ({ label: name, name }));
  const ticked = new Set(initiallyPicked(names, current));
  const patternsButton: vscode.QuickInputButton = {
    iconPath: new vscode.ThemeIcon('edit'),
    tooltip: vscode.l10n.t('Write patterns instead…'),
  };
  const pick = vscode.window.createQuickPick<NameItem>();
  pick.canSelectMany = true;
  pick.items = items;
  pick.selectedItems = items.filter((item) => ticked.has(item.name));
  pick.buttons = [patternsButton];
  pick.title =
    kind === 'databases'
      ? vscode.l10n.t('Databases "{0}" shows', config.name)
      : vscode.l10n.t('Schemas "{0}" shows, in every database', config.name);
  pick.placeholder = vscode.l10n.t(
    'Untick what to hide; tick everything to show all, new ones too',
  );
  const answer = await new Promise<readonly NameItem[] | 'patterns' | undefined>((resolve) => {
    pick.onDidAccept(() => {
      resolve(pick.selectedItems);
      pick.hide();
    });
    pick.onDidTriggerButton(() => {
      resolve('patterns');
      pick.hide();
    });
    pick.onDidHide(() => {
      resolve(undefined);
      pick.dispose();
    });
    pick.show();
  });
  if (answer === undefined) {
    return;
  }
  if (answer === 'patterns') {
    await writePatterns(store, config, kind, current);
    return;
  }
  const outcome = pickOutcome(
    names,
    answer.map((item) => item.name),
  );
  if (outcome.kind === 'none') {
    void vscode.window.showInformationMessage(
      vscode.l10n.t('Keep at least one ticked, or use patterns to hide them all'),
    );
    return;
  }
  await store.setFilter(
    config.id,
    withList(config.filter, kind, outcome.kind === 'all' ? [] : outcome.patterns),
  );
}

async function writePatterns(
  store: ConnectionStore,
  config: ConnectionConfig,
  kind: Kind,
  current: readonly string[],
): Promise<void> {
  const text = await vscode.window.showInputBox({
    title:
      kind === 'databases'
        ? vscode.l10n.t('Databases "{0}" shows', config.name)
        : vscode.l10n.t('Schemas "{0}" shows, in every database', config.name),
    value: current.join(', '),
    placeHolder: 'app_*, !app_test',
    prompt: vscode.l10n.t(
      '* stands for any characters, ? for one, !pattern hides; separate with commas. Empty shows all.',
    ),
  });
  if (text === undefined) {
    return;
  }
  await store.setFilter(config.id, withList(config.filter, kind, parsePatterns(text)));
}
