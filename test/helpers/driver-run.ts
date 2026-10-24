// Shared helpers for driver integration tests: collect an execute() stream into
// a flat result that assertions can look at.

import type { CellValue } from '../../src/shared/cell-value';
import type { ExecuteEvent, ExecuteOptions, ResultColumn, Session } from '../../src/drivers/driver';

export interface CollectedResult {
  /** Column sets in order of appearance (several for multi-set CALLs). */
  readonly columnSets: (readonly ResultColumn[])[];
  readonly rows: (readonly CellValue[])[];
  readonly done: Extract<ExecuteEvent, { kind: 'done' }>;
}

/** Runs one statement and gathers every event; throws if `done` never arrives. */
export async function runAll(
  session: Session,
  sql: string,
  options?: ExecuteOptions,
): Promise<CollectedResult> {
  const columnSets: (readonly ResultColumn[])[] = [];
  const rows: (readonly CellValue[])[] = [];
  let done: Extract<ExecuteEvent, { kind: 'done' }> | undefined;
  for await (const event of session.execute(sql, options)) {
    switch (event.kind) {
      case 'columns':
        columnSets.push(event.columns);
        break;
      case 'rows':
        rows.push(...event.rows);
        break;
      case 'done':
        done = event;
        break;
    }
  }
  if (!done) {
    throw new Error('The execute stream ended without a done event');
  }
  return { columnSets, rows, done };
}

/** First column of every row, for single-column queries. */
export function firstColumn(result: CollectedResult): CellValue[] {
  return result.rows.map((row) => row[0] ?? null);
}
