// "Export Keys…" and "Restore Keys…" of a Redis database, a folder or the selected keys
// (V13.9): which keys, the questions, the production check and the report. The work is in
// services/redis/key-files.ts; the dialogs arrive through `ui`, so this is unit-tested.

import { DbError } from '../../core/errors';
import type { ConnectionStore } from '../../services/connection-store';
import type { TextSink } from '../../services/file-sink';
import type { RedisKeyBrowser } from '../../services/redis/key-browser';
import {
  type ExportReport,
  exportKeys,
  prefixPattern,
  type RestorePolicy,
  type RestoreReport,
  restoreKeys,
} from '../../services/redis/key-files';
import { redisKeyBytes, redisKeyId } from '../../shared/redis-key';
import { isTreeNode, type RedisKeyNode } from '../tree/nodes';
import type { CommandTarget, RefreshableTree } from '../tree/tree-commands';
import type { RedisPlace } from './redis-key-commands';

/** A file being written: it appears under its name only on `close`. */
export interface KeyFileSink extends TextSink {
  close(): Promise<void>;
  discard(): Promise<void>;
}

/** The dialogs and the progress, as the editor shows them. */
export interface KeyFileUi {
  /** Where to write; undefined when the user backs out. */
  pickSaveFile: (defaultName: string) => Promise<string | undefined>;
  /** The file to read; undefined when the user backs out. */
  pickOpenFile: () => Promise<string | undefined>;
  /** What to do with keys that exist; undefined when the user backs out. */
  askPolicy: () => Promise<RestorePolicy | undefined>;
  confirm: (message: string, detail: string | undefined, action: string) => Promise<boolean>;
  /** Runs a task under a cancellable progress; `report` sets the text next to the title. */
  withProgress: <T>(
    title: string,
    task: (signal: { readonly aborted: boolean }, report: (text: string) => void) => Promise<T>,
  ) => Promise<T>;
  showExported: (report: ExportReport, path: string) => void;
  showRestored: (report: RestoreReport, place: string) => void;
}

export interface KeyFileTexts {
  readonly readOnly: string;
  exportTitle(what: string): string;
  restoreTitle(what: string): string;
  keysDone(count: number): string;
  productionQuestion(connection: string): string;
  readonly restoreAction: string;
}

export interface RedisKeyFileDeps {
  readonly browser: Pick<RedisKeyBrowser, 'session' | 'reset'>;
  readonly store: Pick<ConnectionStore, 'get'>;
  readonly tree: RefreshableTree;
  readonly ui: KeyFileUi;
  readonly texts: KeyFileTexts;
  readonly openSink: (path: string) => Promise<KeyFileSink>;
  readonly readChunks: (path: string) => AsyncIterable<{ readonly text: string }>;
  /** A file name for what is exported (no extension). */
  readonly fileNameFor: (text: string) => string;
}

export type RedisKeyFileCommandName = 'exportKeys' | 'restoreKeys';

type Scope =
  | { readonly kind: 'all' }
  | { readonly kind: 'prefix'; readonly prefix: string }
  | { readonly kind: 'keys'; readonly keys: readonly RedisKeyNode[] };

export function redisKeyFileCommandHandlers(
  deps: RedisKeyFileDeps,
): Record<RedisKeyFileCommandName, (target?: CommandTarget, ...rest: unknown[]) => unknown> {
  const placeOf = (target: CommandTarget): RedisPlace | undefined =>
    isTreeNode(target) &&
    (target.kind === 'redisDatabase' || target.kind === 'redisFolder' || target.kind === 'redisKey')
      ? { connectionId: target.connectionId, database: target.database }
      : undefined;

  const scopeOf = (target: CommandTarget, selection: unknown): Scope => {
    if (!isTreeNode(target)) {
      return { kind: 'all' };
    }
    if (target.kind === 'redisFolder') {
      return { kind: 'prefix', prefix: target.prefix };
    }
    if (target.kind !== 'redisKey') {
      return { kind: 'all' };
    }
    const chosen = (Array.isArray(selection) ? selection : [])
      .filter(isTreeNode)
      .filter(
        (node): node is RedisKeyNode =>
          node.kind === 'redisKey' &&
          node.connectionId === target.connectionId &&
          node.database === target.database,
      );
    return {
      kind: 'keys',
      keys: chosen.some((node) => redisKeyId(node.key) === redisKeyId(target.key))
        ? chosen
        : [target],
    };
  };

  const refreshDatabase = (place: RedisPlace): void => {
    deps.browser.reset(place.connectionId, place.database);
    deps.tree.refresh({
      kind: 'redisDatabase',
      connectionId: place.connectionId,
      database: place.database,
      keys: 0,
    });
  };

  return {
    exportKeys: async (target?: CommandTarget, selection?: unknown) => {
      const place = placeOf(target);
      if (place === undefined) {
        return undefined;
      }
      const scope = scopeOf(target, selection);
      const config = deps.store.get(place.connectionId);
      const what = `${config?.name ?? place.connectionId} #${place.database}${
        scope.kind === 'prefix' ? ` ${scope.prefix}` : ''
      }`;
      const path = await deps.ui.pickSaveFile(`${deps.fileNameFor(what)}.redis.jsonl`);
      if (path === undefined) {
        return undefined;
      }
      const match = scope.kind === 'prefix' ? prefixPattern(scope.prefix) : undefined;
      const sink = await deps.openSink(path);
      let report: ExportReport;
      try {
        report = await deps.ui.withProgress(
          deps.texts.exportTitle(what),
          async (signal, progress) =>
            await exportKeys({
              session: await deps.browser.session(place.connectionId, place.database),
              ...(match === undefined ? {} : { match }),
              ...(scope.kind === 'keys'
                ? { keys: scope.keys.map((node) => redisKeyBytes(node.key)) }
                : {}),
              sink,
              signal,
              onProgress: (keys) => {
                progress(deps.texts.keysDone(keys));
              },
            }),
        );
      } catch (error) {
        await sink.discard();
        throw error;
      }
      if (report.cancelled) {
        await sink.discard();
      } else {
        await sink.close();
      }
      deps.ui.showExported(report, path);
      return undefined;
    },

    restoreKeys: async (target?: CommandTarget) => {
      const place = placeOf(target);
      if (place === undefined) {
        return undefined;
      }
      const config = deps.store.get(place.connectionId);
      if (config?.readOnly === true) {
        throw new DbError('permission-denied', deps.texts.readOnly);
      }
      const path = await deps.ui.pickOpenFile();
      if (path === undefined) {
        return undefined;
      }
      const policy = await deps.ui.askPolicy();
      if (policy === undefined) {
        return undefined;
      }
      if (
        config?.production === true &&
        !(await deps.ui.confirm(
          deps.texts.productionQuestion(config.name),
          undefined,
          deps.texts.restoreAction,
        ))
      ) {
        return undefined;
      }
      const what = `${config?.name ?? place.connectionId} #${place.database}`;
      try {
        const report = await deps.ui.withProgress(
          deps.texts.restoreTitle(what),
          async (signal, progress) =>
            await restoreKeys({
              session: await deps.browser.session(place.connectionId, place.database),
              chunks: deps.readChunks(path),
              policy,
              signal,
              onProgress: (keys) => {
                progress(deps.texts.keysDone(keys));
              },
            }),
        );
        deps.ui.showRestored(report, what);
      } finally {
        // Whatever was written before a stop or a failure is in the database.
        refreshDatabase(place);
      }
      return undefined;
    },
  };
}
