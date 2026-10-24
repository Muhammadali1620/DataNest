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

/** True when a configuration change touches one of our settings. */
export function affectsDataNest(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(CONFIG_SECTION);
}
