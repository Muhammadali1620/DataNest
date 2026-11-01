// Brings the result tabs of saved SQL files back after the editor restarts (V13.12): the
// tabs the file had are remembered as they change, put back, empty, when the file shows
// up in an editor, and a panel is opened for them. The rules are in services/result-memory.

import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import {
  type RememberRules,
  type ResultMemory,
  type ResultRestorer,
  recordResults,
} from '../services/result-memory';
import type { ResultStore } from '../services/result-store';

export interface ResultRestoreDeps {
  readonly results: ResultStore;
  readonly memory: ResultMemory;
  readonly restorer: ResultRestorer;
  readonly rules: RememberRules;
  /** The `datanest.results.restore` setting. */
  readonly enabled: () => boolean;
  /** Opens the result panel of a file. */
  readonly showResults: (documentUri: string) => void;
  /** Fires when connections change: project connections arrive after start-up. */
  readonly onConnectionsChanged: (listener: () => void) => { dispose(): void };
  readonly logger: Logger;
}

/** Wait before the first look at the open editors. */
export const INITIAL_DELAY_MS = 300;

export function registerResultRestore(deps: ResultRestoreDeps): vscode.Disposable {
  const log = deps.logger.child('results');
  const onError = (error: unknown): void => {
    log.warn('Could not keep the result tabs of a file', error);
  };

  const visit = (): void => {
    if (!deps.enabled()) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId !== 'sql') {
        continue;
      }
      const documentUri = editor.document.uri.toString();
      const outcome = deps.restorer.restore(documentUri);
      if (outcome.restored > 0) {
        deps.showResults(documentUri);
        outcome.finished.catch(onError);
      }
    }
  };

  const subscriptions: { dispose(): unknown }[] = [
    recordResults(deps.results, deps.memory, deps.rules, onError),
    vscode.window.onDidChangeVisibleTextEditors(visit),
    deps.onConnectionsChanged(visit),
    vscode.workspace.onDidRenameFiles((event) => {
      for (const { oldUri, newUri } of event.files) {
        deps.memory.rename(oldUri.toString(), newUri.toString()).catch(onError);
      }
    }),
  ];
  // Editors already open at start-up; a moment later, so the run commands are registered.
  const first = setTimeout(visit, INITIAL_DELAY_MS);
  subscriptions.push({
    dispose: () => {
      clearTimeout(first);
    },
  });
  return vscode.Disposable.from(...subscriptions);
}
