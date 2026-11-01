// Moving a list of connections between computers or people (V4.11): exported as a
// connection file — the same format as a project's `.vscode/datanest.json` — and
// imported from one. Passwords and other secrets never leave SecretStorage.

import type { ConnectionConfig, ConnectionInput } from '../shared/connection';
import { cleanFolderPath, withAncestors } from '../shared/folder-path';
import { entryJson, readConnectionFile, writeConnectionFile } from '../shared/connection-file';
import type { ConnectionStore } from './connection-store';
import { sameTarget } from './env-import';

/**
 * The text of an export: each connection without its id (ids belong to one
 * computer), and the order of the folders they use, so an import rebuilds the tree.
 */
export function exportConnections(
  configs: readonly ConnectionConfig[],
  folderOrder: readonly string[],
): string {
  // A nested folder brings the folders around it, so the file's order is complete (V13.8).
  const used = new Set(
    withAncestors(
      configs.flatMap((config) => (config.folder === undefined ? [] : [config.folder])),
    ),
  );
  return writeConnectionFile({
    // Whether a connection is switched off is a matter of this machine, not of the file.
    connections: configs.map(({ id: _id, disabled: _off, ...input }) => entryJson({ input })),
    folders: folderOrder.filter((folder) => used.has(folder)),
  });
}

/** A connection of an import file, and the saved one that already goes to the same place. */
export interface ImportCandidate {
  readonly input: ConnectionInput;
  readonly known?: ConnectionConfig;
}

export interface ImportPlan {
  readonly candidates: readonly ImportCandidate[];
  /** Entries that could not be read, by position (from 1). */
  readonly skipped: readonly { readonly position: number; readonly problem: string }[];
  /** The folder order the file keeps. */
  readonly folders: readonly string[];
}

export type ImportRead =
  { readonly ok: true; readonly plan: ImportPlan } | { readonly ok: false; readonly error: string };

/** What a file offers to import, compared with what is already saved. */
export function readImport(text: string, saved: readonly ConnectionConfig[]): ImportRead {
  const result = readConnectionFile(text);
  if (!result.ok) {
    return result;
  }
  const candidates: ImportCandidate[] = [];
  const skipped: { position: number; problem: string }[] = [];
  result.file.entries.forEach((entry, index) => {
    if (!entry.ok) {
      skipped.push({ position: index + 1, problem: entry.problem });
      return;
    }
    const known = saved.find((config) => sameTarget(config, entry.entry.input));
    candidates.push({ input: entry.entry.input, ...(known === undefined ? {} : { known }) });
  });
  return { ok: true, plan: { candidates, skipped, folders: result.file.folders } };
}

/**
 * Adds the chosen connections to the user's list. Folders the file names are made
 * first, in the file's order, so the tree looks the way it did where it came from.
 */
export async function importConnections(
  store: Pick<ConnectionStore, 'add' | 'createFolder' | 'folders'>,
  chosen: readonly ConnectionInput[],
  folderOrder: readonly string[],
): Promise<ConnectionConfig[]> {
  const wanted = new Set(
    chosen.flatMap((input) => {
      const folder = cleanFolderPath(input.folder);
      return folder === undefined ? [] : [folder];
    }),
  );
  const existing = new Set(store.folders());
  for (const folder of [...folderOrder, ...wanted]) {
    if (wanted.has(folder) && !existing.has(folder)) {
      await store.createFolder(folder);
      // The folders around a nested one were made with it.
      for (const made of withAncestors([folder])) {
        existing.add(made);
      }
    }
  }
  const added: ConnectionConfig[] = [];
  for (const input of chosen) {
    added.push(await store.add(input));
  }
  return added;
}
