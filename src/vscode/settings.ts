import * as vscode from 'vscode';
import { DEFAULT_SAFE_MODE, isSafeMode, type SafeMode } from '../services/safe-mode';
import { DEFAULT_HISTORY_LIMIT } from '../services/history';
import { DEFAULT_FORMAT_STYLE, type FormatStyle } from '../services/sql-format';
import { CONFIG_KEYS, CONFIG_SECTION } from './command-ids';
import { isTransactionMode, type TransactionMode } from './editor/transaction-modes';
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

/** The format settings; indentation comes from the editor, not from here. */
export function readFormatStyle(indent: {
  readonly tabSize: number;
  readonly insertSpaces: boolean;
}): FormatStyle {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
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
