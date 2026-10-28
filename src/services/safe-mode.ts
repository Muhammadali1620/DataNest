// Safe mode: before a script runs, find the statements that can wipe out data and
// let the user confirm (or forbid) them. Pure, so every rule is a unit test; the
// dialog itself lives in the editor integration.

import { type Danger, dangersOf } from '../core/sql/danger';
import type { SqlStatement } from '../core/sql/split';
import { syntaxOf } from '../core/sql/tokenizer';
import type { DriverId } from '../shared/connection';

export const SAFE_MODES = ['confirm', 'block', 'off'] as const;
export type SafeMode = (typeof SAFE_MODES)[number];

export const DEFAULT_SAFE_MODE: SafeMode = 'confirm';

export function isSafeMode(value: unknown): value is SafeMode {
  return SAFE_MODES.some((mode) => mode === value);
}

export interface RiskyStatement {
  readonly statement: SqlStatement;
  readonly dangers: readonly Danger[];
}

/** The statements of a run that safe mode wants a word about; none when it is off. */
export function riskyStatements(
  statements: readonly SqlStatement[],
  driver: DriverId | undefined,
  mode: SafeMode,
): RiskyStatement[] {
  if (mode === 'off') {
    return [];
  }
  const syntax = syntaxOf(driver);
  return statements.flatMap((statement) => {
    const dangers = dangersOf(statement.text, syntax);
    return dangers.length === 0 ? [] : [{ statement, dangers }];
  });
}
