// Formatting SQL documents. Each statement is formatted on its own and put back in
// its place, so what lies between statements — comments, blank lines, DELIMITER
// commands, the terminators themselves — stays exactly as the user wrote it.

import { createRequire } from 'node:module';
import { errorMessage } from '../core/errors';
import { splitStatements, statementsIn } from '../core/sql/split';
import type { DriverId } from '../shared/connection';

export type KeywordCase = 'preserve' | 'upper' | 'lower';

/** The style settings (`datanest.format.*`) plus the editor's indentation. */
export interface FormatStyle {
  readonly keywordCase: KeywordCase;
  readonly dataTypeCase: KeywordCase;
  readonly functionCase: KeywordCase;
  readonly indentStyle: 'standard' | 'tabularLeft' | 'tabularRight';
  readonly logicalOperatorNewline: 'before' | 'after';
  /** Parenthesized expressions shorter than this stay on one line. */
  readonly expressionWidth: number;
  readonly denseOperators: boolean;
  readonly tabWidth: number;
  readonly useTabs: boolean;
}

export const DEFAULT_FORMAT_STYLE: FormatStyle = {
  keywordCase: 'upper',
  dataTypeCase: 'preserve',
  functionCase: 'preserve',
  indentStyle: 'standard',
  logicalOperatorNewline: 'before',
  expressionWidth: 50,
  denseOperators: false,
  tabWidth: 2,
  useTabs: false,
};

/** Dialects the formatter knows; `sql` is plain standard SQL. */
export type FormatLanguage =
  'mysql' | 'postgresql' | 'sqlite' | 'transactsql' | 'clickhouse' | 'plsql' | 'sql';

export function languageOf(driver: DriverId | undefined): FormatLanguage {
  switch (driver) {
    case 'mysql':
      return 'mysql';
    case 'postgres':
      return 'postgresql';
    case 'sqlite':
      return 'sqlite';
    case 'mssql':
      return 'transactsql';
    case 'clickhouse':
      return 'clickhouse';
    case 'oracle':
      return 'plsql';
    case 'redis':
    case 'mongodb':
    case undefined:
      return 'sql';
  }
}

/** The shape of dist/formatter.js, which carries sql-formatter and loads on first use. */
export interface FormatterModule {
  /** Formats one statement; throws when the text cannot be parsed. */
  format(sql: string, language: FormatLanguage, style: FormatStyle): string;
}

export type FormatterLoader = () => FormatterModule;

/** Resolves `./formatter.js` next to the running bundle (dist/extension.js). */
export function createBundleFormatterLoader(bundlePath: string): FormatterLoader {
  const requireFromBundle = createRequire(bundlePath);
  let loaded: FormatterModule | undefined;
  return () => {
    loaded ??= (requireFromBundle('./formatter.js') as { formatter: FormatterModule }).formatter;
    return loaded;
  };
}

export interface FormatEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

export interface FormatResult {
  readonly edits: readonly FormatEdit[];
  /** Statements the formatter could not read; they are left as they are. */
  readonly failed: number;
  /** The first reason, for the log. */
  readonly reason?: string;
}

/**
 * Edits that format the statements of `text`, all of them or those that overlap
 * `[from, to)`. A statement that is already formatted produces no edit.
 */
export function formatEdits(
  text: string,
  driver: DriverId | undefined,
  style: FormatStyle,
  formatter: FormatterModule,
  range?: { readonly from: number; readonly to: number },
): FormatResult {
  const statements =
    range === undefined
      ? splitStatements(text, driver)
      : statementsIn(text, range.from, range.to, driver);
  const edits: FormatEdit[] = [];
  let failed = 0;
  let reason: string | undefined;
  for (const statement of statements) {
    try {
      const formatted = formatter.format(statement.text, languageOf(driver), style).trim();
      if (formatted !== '' && formatted !== statement.text) {
        edits.push({ start: statement.start, end: statement.end, text: formatted });
      }
    } catch (error) {
      failed += 1;
      reason ??= errorMessage(error);
    }
  }
  return reason === undefined ? { edits, failed } : { edits, failed, reason };
}
