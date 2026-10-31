// CHECK constraints of an Oracle table. ALL_CONSTRAINTS lists every NOT NULL as a
// check of type C too; those belong to the column, so they are left out.

import type { CheckConstraint } from '../../core/model/objects';

/** `"ID" IS NOT NULL`: the condition Oracle writes for a NOT NULL column. */
const NOT_NULL = /^\s*(?:"(?:[^"]|"")+"|[A-Za-z][\w$#]*)\s+IS\s+NOT\s+NULL\s*$/i;

/** Rows of `SELECT constraint_name, search_condition`, as the checks to show. */
export function oracleChecks(rows: readonly (readonly unknown[])[]): CheckConstraint[] {
  const checks: CheckConstraint[] = [];
  for (const row of rows) {
    const name = row[0];
    const condition = row[1];
    if (typeof name !== 'string' || typeof condition !== 'string' || NOT_NULL.test(condition)) {
      continue;
    }
    // The dictionary prints the condition without CHECK and without parentheses.
    checks.push({ name, expression: `(${condition.trim()})` });
  }
  return checks;
}
