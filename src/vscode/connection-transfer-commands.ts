import * as vscode from 'vscode';
import type { Logger } from '../core/logging/logger';
import {
  exportConnections,
  type ImportCandidate,
  importConnections,
  readImport,
} from '../services/connection-transfer';
import type { ConnectionStore } from '../services/connection-store';
import { type ConnectionConfig, describeTarget } from '../shared/connection';

export interface TransferCommandDeps {
  readonly store: ConnectionStore;
  readonly logger: Logger;
}

const FILTERS = { JSON: ['json'] };

interface ConnectionItem extends vscode.QuickPickItem {
  readonly config: ConnectionConfig;
}

interface CandidateItem extends vscode.QuickPickItem {
  readonly candidate: ImportCandidate;
}

/** "Export Connections…" and "Import Connections…" (V4.11). */
export function transferCommandHandlers(deps: TransferCommandDeps): {
  exportConnections: () => Promise<void>;
  importConnections: (file?: unknown) => Promise<void>;
} {
  const { store, logger } = deps;

  const exportAll = async (): Promise<void> => {
    const all = store.list();
    if (all.length === 0) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t('There are no saved connections yet'),
      );
      return;
    }
    const items: ConnectionItem[] = all.map((config) => {
      const project = store.projectOf(config.id);
      return {
        label: config.name,
        description: describeTarget(config),
        ...(project === undefined
          ? config.folder === undefined
            ? {}
            : { detail: config.folder }
          : { detail: vscode.l10n.t('Project "{0}"', project.name) }),
        picked: true,
        config,
      };
    });
    const chosen = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Export Connections'),
      placeHolder: vscode.l10n.t('Pick the connections to export; passwords are never exported'),
      canPickMany: true,
      matchOnDescription: true,
    });
    if (chosen === undefined || chosen.length === 0) {
      return;
    }
    const base = vscode.workspace.workspaceFolders?.[0]?.uri;
    const target = await vscode.window.showSaveDialog({
      title: vscode.l10n.t('Export Connections'),
      filters: FILTERS,
      ...(base === undefined
        ? {}
        : { defaultUri: vscode.Uri.joinPath(base, 'datanest-connections.json') }),
    });
    if (target === undefined) {
      return;
    }
    const text = exportConnections(
      chosen.map((item) => item.config),
      store.folders(),
    );
    await vscode.workspace.fs.writeFile(target, new TextEncoder().encode(text));
    logger.info(`Exported ${chosen.length} connection(s) to ${target.fsPath}`);
    void vscode.window.showInformationMessage(
      vscode.l10n.t(
        'Exported {0} connection(s). Passwords are not in the file: each person sets their own.',
        chosen.length,
      ),
    );
  };

  const importFrom = async (file?: unknown): Promise<void> => {
    const source = file instanceof vscode.Uri ? file : await pickFile();
    if (source === undefined) {
      return;
    }
    const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(source));
    const read = readImport(text, store.list());
    if (!read.ok) {
      void vscode.window.showErrorMessage(
        vscode.l10n.t('This is not a DataNest connection file: {0}', read.error),
      );
      return;
    }
    const { candidates, skipped, folders } = read.plan;
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(
        skipped.length === 0
          ? vscode.l10n.t('The file lists no connections')
          : vscode.l10n.t(
              'None of the {0} connection(s) in the file could be read',
              skipped.length,
            ),
      );
      return;
    }
    const items: CandidateItem[] = candidates.map((candidate) => ({
      label: candidate.input.name,
      description:
        candidate.known === undefined
          ? describeTarget(candidate.input)
          : vscode.l10n.t(
              '{0} — already saved as "{1}"',
              describeTarget(candidate.input),
              candidate.known.name,
            ),
      ...(candidate.input.folder === undefined ? {} : { detail: candidate.input.folder }),
      picked: candidate.known === undefined,
      candidate,
    }));
    const chosen = await vscode.window.showQuickPick(items, {
      title: vscode.l10n.t('Import Connections'),
      placeHolder: vscode.l10n.t('Pick the connections to add to yours'),
      canPickMany: true,
      matchOnDescription: true,
    });
    if (chosen === undefined || chosen.length === 0) {
      return;
    }
    const added = await importConnections(
      store,
      chosen.map((item) => item.candidate.input),
      folders,
    );
    logger.info(`Imported ${added.length} connection(s) from ${source.fsPath}`);
    void vscode.window.showInformationMessage(
      [
        vscode.l10n.t(
          'Imported {0} connection(s). Set their passwords with Edit Connection.',
          added.length,
        ),
        ...(skipped.length === 0
          ? []
          : [vscode.l10n.t('{0} entr(ies) of the file could not be read.', skipped.length)]),
      ].join(' '),
    );
  };

  return { exportConnections: exportAll, importConnections: importFrom };
}

async function pickFile(): Promise<vscode.Uri | undefined> {
  const chosen = await vscode.window.showOpenDialog({
    title: vscode.l10n.t('Import Connections'),
    canSelectMany: false,
    filters: FILTERS,
  });
  return chosen?.[0];
}
