import * as vscode from 'vscode';
import { CONFIG_KEYS, CONFIG_SECTION } from './command-ids';
import type { TreeSettings } from './tree/tree-model';

/**
 * Reads DataNest settings on every call, so a change in the editor takes effect
 * without restarting anything. Services get this as a small interface.
 */
export function createSettings(): TreeSettings {
  return {
    showSystemObjects: () =>
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>(CONFIG_KEYS.showSystemObjects, false),
  };
}

/** How many rows one statement may bring back; the rest needs a bigger limit. */
export const DEFAULT_ROW_LIMIT = 1000;

export function readRowLimit(): number {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(CONFIG_KEYS.rowLimit, DEFAULT_ROW_LIMIT);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_ROW_LIMIT;
}

/** Rows one page of a table view holds. */
export const DEFAULT_PAGE_SIZE = 200;

export function readPageSize(): number {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(CONFIG_KEYS.pageSize, DEFAULT_PAGE_SIZE);
  return Number.isInteger(value) && value > 0 ? value : DEFAULT_PAGE_SIZE;
}

/** True when a configuration change touches one of our settings. */
export function affectsDataNest(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(CONFIG_SECTION);
}
