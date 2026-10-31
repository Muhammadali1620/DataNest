import * as vscode from 'vscode';
import { DEFAULT_SAFE_MODE, isSafeMode, type SafeMode } from '../services/safe-mode';
import { DEFAULT_HISTORY_LIMIT } from '../services/history';
import { isQueryVariablesMode, type QueryVariablesMode } from '../services/query-variables';
import { DEFAULT_FORMAT_STYLE, type FormatStyle } from '../services/sql-format';
import { CONFIG_KEYS, CONFIG_SECTION } from './command-ids';
import { isTransactionMode, type TransactionMode } from './editor/transaction-modes';
import type { TreeSettings } from './tree/tree-model';
import type { KeyBrowserSettings } from '../services/redis/key-browser';

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
    showSizes: () =>
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>(CONFIG_KEYS.treeShowSizes, true),
    tableStats: () =>
      vscode.workspace
        .getConfiguration(CONFIG_SECTION)
        .get<boolean>(CONFIG_KEYS.treeTableStats, true),
  };
}

/** The default of `datanest.redis.keysPerLoad`. */
export const DEFAULT_REDIS_KEYS_PER_LOAD = 5000;

/** What the Redis key tree reads (V7.2), asked at every load. */
export function createRedisKeySettings(): KeyBrowserSettings {
  const config = (): vscode.WorkspaceConfiguration =>
    vscode.workspace.getConfiguration(CONFIG_SECTION);
  return {
    separator: () => {
      const value = config().get<string>(CONFIG_KEYS.redisKeySeparator, ':');
      return typeof value === 'string' ? value : ':';
    },
    keysPerLoad: () => {
      const value = config().get<number>(CONFIG_KEYS.redisKeysPerLoad, DEFAULT_REDIS_KEYS_PER_LOAD);
      return Number.isInteger(value) && value > 0 ? value : DEFAULT_REDIS_KEYS_PER_LOAD;
    },
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

/** Seconds a statement may run before DataNest cancels it; 0 turns the limit off. */
export const DEFAULT_QUERY_TIMEOUT_SECONDS = 0;

/** The timeout in milliseconds, or 0 when the user turned it off. */
export function readQueryTimeoutMs(): number {
  const seconds = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(CONFIG_KEYS.queryTimeout, DEFAULT_QUERY_TIMEOUT_SECONDS);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return 0;
  }
  return Math.round(seconds * 1000);
}

/** Executed statements the query history keeps. */
export function readHistoryLimit(): number {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<number>(CONFIG_KEYS.historyLimit, DEFAULT_HISTORY_LIMIT);
  return Number.isInteger(value) && value >= 0 ? value : DEFAULT_HISTORY_LIMIT;
}

/** What to do before running a statement that can destroy data. */
export function readSafeMode(): SafeMode {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>(CONFIG_KEYS.safeMode, DEFAULT_SAFE_MODE);
  return isSafeMode(value) ? value : DEFAULT_SAFE_MODE;
}

/** Whether the connection list travels with the editor's Settings Sync (V10.2.5). */
export function readSyncConnections(): boolean {
  return vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<boolean>(CONFIG_KEYS.syncConnections, false);
}

/** What query variables do (V10.2.1). */
export function readQueryVariablesMode(): QueryVariablesMode {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>(CONFIG_KEYS.queryVariables, 'remember');
  return isQueryVariablesMode(value) ? value : 'remember';
}

/** One of the on/off settings of SQL editors (V10.2.2); all of them are on by default. */
export function readEditorSwitch(
  key:
    | typeof CONFIG_KEYS.editorCodeLens
    | typeof CONFIG_KEYS.editorHighlightStatement
    | typeof CONFIG_KEYS.editorFoldStatements,
): boolean {
  // Only `false` turns one off; anything else a hand-edited file holds leaves it on.
  const value: unknown = vscode.workspace.getConfiguration(CONFIG_SECTION).get(key, true);
  return value !== false;
}

/** The mode a SQL editor starts in, until the user switches it there (V4.8). */
export function readTransactionMode(): TransactionMode {
  const value = vscode.workspace
    .getConfiguration(CONFIG_SECTION)
    .get<string>(CONFIG_KEYS.transactionMode, 'auto');
  return isTransactionMode(value) ? value : 'auto';
}

/** One of `allowed`, or the fallback when the setting holds something else. */
function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.find((option) => option === value) ?? fallback;
}

/**
 * The format settings; indentation comes from the editor, not from here. They are
 * resource-scoped, so they are read for the document being formatted: a folder of a
 * multi-root workspace can have its own style.
 */
export function readFormatStyle(
  indent: {
    readonly tabSize: number;
    readonly insertSpaces: boolean;
  },
  scope: vscode.ConfigurationScope | null,
): FormatStyle {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION, scope);
  const cases = ['preserve', 'upper', 'lower'] as const;
  const width = config.get<number>(
    CONFIG_KEYS.formatExpressionWidth,
    DEFAULT_FORMAT_STYLE.expressionWidth,
  );
  const d = DEFAULT_FORMAT_STYLE;
  return {
    keywordCase: oneOf(config.get(CONFIG_KEYS.formatKeywordCase), cases, d.keywordCase),
    dataTypeCase: oneOf(config.get(CONFIG_KEYS.formatDataTypeCase), cases, d.dataTypeCase),
    functionCase: oneOf(config.get(CONFIG_KEYS.formatFunctionCase), cases, d.functionCase),
    indentStyle: oneOf(
      config.get(CONFIG_KEYS.formatIndentStyle),
      ['standard', 'tabularLeft', 'tabularRight'] as const,
      d.indentStyle,
    ),
    logicalOperatorNewline: oneOf(
      config.get(CONFIG_KEYS.formatLogicalOperatorNewline),
      ['before', 'after'] as const,
      d.logicalOperatorNewline,
    ),
    expressionWidth: Number.isInteger(width) && width > 0 ? width : d.expressionWidth,
    denseOperators: config.get<boolean>(CONFIG_KEYS.formatDenseOperators, d.denseOperators),
    tabWidth: indent.tabSize > 0 ? indent.tabSize : d.tabWidth,
    useTabs: !indent.insertSpaces,
  };
}

/** True when a configuration change touches one of our settings. */
export function affectsDataNest(event: vscode.ConfigurationChangeEvent): boolean {
  return event.affectsConfiguration(CONFIG_SECTION);
}
