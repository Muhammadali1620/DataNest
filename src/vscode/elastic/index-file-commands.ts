// "Export Index…", "Import Documents…" and "Import as New Index…" of Elasticsearch
// (V13.11): which index, the questions, the production check and what the tree does
// afterwards. The work is in services/elasticsearch/index-files.ts; the dialogs arrive
// through `ui`, so this is unit-tested like the Redis key files (V13.9).

import { DbError } from '../../core/errors';
import type { ConnectionManager } from '../../services/connection-manager';
import type { ConnectionStore } from '../../services/connection-store';
import { createIndex, indexNameProblem } from '../../services/elasticsearch/catalog';
import {
  createBodyOf,
  exportIndex,
  type IdMode,
  importIndex,
  type IndexFileFormat,
  readFileHeader,
  type WriteOp,
} from '../../services/elasticsearch/index-files';
import type { TextSink } from '../../services/file-sink';
import type { ImportMode, ImportReport } from '../../services/mongodb/collection-files';
import { elasticTreeSession } from '../tree/elastic-tree';
import { connectionIdOf, isTreeNode } from '../tree/nodes';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';

/** A file being written: it appears under its name only on `close`. */
export interface IndexFileSink extends TextSink {
  close(): Promise<void>;
  discard(): Promise<void>;
}

/** What the user chose for a load. */
export interface ImportOptions {
  readonly mode: ImportMode;
  readonly ids: IdMode;
  readonly op: WriteOp;
}

/** The dialogs and the progress, as the editor shows them. */
export interface IndexFileUi {
  pickFormat: (index: string) => Promise<IndexFileFormat | undefined>;
  /** Where to write; undefined when the user backs out. */
  pickSaveFile: (defaultName: string, index: string) => Promise<string | undefined>;
  /** The file to read; undefined when the user backs out. */
  pickOpenFile: (title: string) => Promise<string | undefined>;
  askImportOptions: (title: string) => Promise<ImportOptions | undefined>;
  /** The name of a new index; `check` returns what is wrong with a name, or undefined. */
  askIndexName: (
    suggested: string,
    check: (text: string) => string | undefined,
  ) => Promise<string | undefined>;
  confirm: (message: string, detail: string | undefined, action: string) => Promise<boolean>;
  /** Runs a task under a cancellable progress; `report` sets the text next to the title. */
  withProgress: <T>(
    title: string,
    task: (signal: { readonly aborted: boolean }, report: (text: string) => void) => Promise<T>,
  ) => Promise<T>;
  showExported: (result: { documents: number; cancelled: boolean }, path: string) => void;
  showImported: (report: ImportReport, index: string) => void;
}

export interface IndexFileTexts {
  readonly readOnly: string;
  readonly noElastic: string;
  exportTitle(index: string): string;
  importTitle(index: string): string;
  readonly importNewTitle: string;
  documentsDone(count: number): string;
  productionQuestion(connection: string, index: string): string;
  readonly importAction: string;
}

export interface IndexFileDeps {
  readonly manager: Pick<ConnectionManager, 'acquireElastic'>;
  readonly store: Pick<ConnectionStore, 'get'>;
  readonly tree: RefreshableTree;
  readonly ui: IndexFileUi;
  readonly texts: IndexFileTexts;
  readonly openSink: (path: string) => Promise<IndexFileSink>;
  readonly readChunks: (path: string) => AsyncIterable<{ readonly text: string }>;
  /** A file name for what is exported or loaded (no extension). */
  readonly fileNameFor: (text: string) => string;
}

export type IndexFileCommandName = 'exportIndex' | 'importIndex' | 'importNewIndex';

/** The name of a file without its folder and extension. */
function baseName(path: string): string {
  const name = path.split(/[\\/]/u).pop() ?? '';
  return name.replace(/\.[^.]*$/u, '');
}

export function indexFileCommandHandlers(
  deps: IndexFileDeps,
): Record<IndexFileCommandName, (target?: CommandTarget) => Promise<void>> {
  const { ui, texts } = deps;

  const refuseReadOnly = (connectionId: string): void => {
    if (deps.store.get(connectionId)?.readOnly === true) {
      throw new DbError('permission-denied', texts.readOnly);
    }
  };

  const confirmWrite = async (connectionId: string, index: string): Promise<boolean> => {
    const config = deps.store.get(connectionId);
    return config?.production === true
      ? await ui.confirm(
          texts.productionQuestion(config.name, index),
          undefined,
          texts.importAction,
        )
      : true;
  };

  /** Sends a file to an index under a progress, then shows what came of it. */
  const send = async (
    connectionId: string,
    index: string,
    path: string,
    options: ImportOptions,
  ): Promise<void> => {
    const report = await ui.withProgress(
      texts.importTitle(index),
      async (signal, report) =>
        await importIndex({
          session: await elasticTreeSession(deps.manager, connectionId),
          index,
          chunks: deps.readChunks(path),
          ...options,
          signal,
          onProgress: (count) => {
            report(texts.documentsDone(count));
          },
        }),
    );
    deps.tree.refresh({ kind: 'connection', connectionId });
    ui.showImported(report, index);
  };

  return {
    exportIndex: async (target) => {
      if (!isTreeNode(target) || target.kind !== 'elasticIndex') {
        return;
      }
      const index = target.index.name;
      const format = await ui.pickFormat(index);
      if (format === undefined) {
        return;
      }
      const path = await ui.pickSaveFile(`${deps.fileNameFor(index)}.ndjson`, index);
      if (path === undefined) {
        return;
      }
      const sink = await deps.openSink(path);
      const result = await ui.withProgress(texts.exportTitle(index), async (signal, report) => {
        try {
          const outcome = await exportIndex({
            session: await elasticTreeSession(deps.manager, target.connectionId),
            index,
            format,
            sink,
            signal,
            onProgress: (count) => {
              report(texts.documentsDone(count));
            },
          });
          // A cancelled export leaves no file; a half-written one would pass for a whole one.
          await (outcome.cancelled ? sink.discard() : sink.close());
          return outcome;
        } catch (error) {
          await sink.discard();
          throw error;
        }
      });
      ui.showExported(result, path);
    },

    importIndex: async (target) => {
      if (!isTreeNode(target) || target.kind !== 'elasticIndex') {
        return;
      }
      const index = target.index.name;
      refuseReadOnly(target.connectionId);
      const title = texts.importTitle(index);
      const path = await ui.pickOpenFile(title);
      if (path === undefined) {
        return;
      }
      const options = await ui.askImportOptions(title);
      if (options === undefined || !(await confirmWrite(target.connectionId, index))) {
        return;
      }
      await send(target.connectionId, index, path, options);
    },

    importNewIndex: async (target) => {
      const connectionId = connectionIdOf(target);
      if (connectionId === undefined || deps.store.get(connectionId)?.driver !== 'elasticsearch') {
        throw new DbError('not-found', texts.noElastic);
      }
      refuseReadOnly(connectionId);
      const path = await ui.pickOpenFile(texts.importNewTitle);
      if (path === undefined) {
        return;
      }
      const header = await readFileHeader(deps.readChunks(path));
      const name = await ui.askIndexName(
        header?.index ?? deps.fileNameFor(baseName(path)).toLowerCase(),
        (text) => indexNameProblem(text.trim()),
      );
      if (name === undefined) {
        return;
      }
      const index = name.trim();
      const options = await ui.askImportOptions(texts.importNewTitle);
      if (options === undefined || !(await confirmWrite(connectionId, index))) {
        return;
      }
      // The index is made first, with the shape the file carries; it exists even if the load stops.
      await createIndex(
        await elasticTreeSession(deps.manager, connectionId),
        index,
        createBodyOf(header),
      );
      await send(connectionId, index, path, options);
    },
  };
}
