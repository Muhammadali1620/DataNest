import type { ForeignKey, TableRef } from '../../core/model/objects';

/**
 * Rows of (index, column) in index order become one list per index. An index with a
 * missing column name is an expression index and is dropped whole.
 */
export function groupKeys(
  rows: readonly (readonly [string | undefined, string | undefined])[],
): string[][] {
  const keys = new Map<string, string[] | null>();
  for (const [index, column] of rows) {
    if (index === undefined) {
      continue;
    }
    // null marks an index already dropped; it must stay dropped.
    const key = keys.has(index) ? keys.get(index) : [];
    keys.set(
      index,
      key === null || key === undefined || column === undefined ? null : [...key, column],
    );
  }
  return [...keys.values()].filter((key): key is string[] => key !== null && key.length > 0);
}

/** One row of a foreign key listing: a column pair of one constraint. */
export interface ForeignKeyRow {
  /** Identifies the constraint within the table; rows of one constraint are adjacent. */
  readonly id: string | undefined;
  readonly name: string | undefined;
  readonly column: string | undefined;
  readonly target: TableRef | undefined;
  readonly targetColumn: string | undefined;
}

/**
 * Column pairs grouped into keys. A constraint with a missing name part is dropped
 * whole, because half a key would send the user to the wrong row.
 */
export function groupForeignKeys(rows: readonly ForeignKeyRow[]): ForeignKey[] {
  const keys = new Map<
    string,
    { name: string; columns: string[]; targetColumns: string[]; target: TableRef } | null
  >();
  for (const row of rows) {
    if (row.id === undefined) {
      continue;
    }
    const known = keys.get(row.id);
    if (known === null) {
      continue;
    }
    if (
      row.column === undefined ||
      row.target === undefined ||
      row.targetColumn === undefined ||
      (known !== undefined && known.target.name !== row.target.name)
    ) {
      keys.set(row.id, null);
      continue;
    }
    if (known === undefined) {
      keys.set(row.id, {
        name: row.name ?? row.id,
        columns: [row.column],
        targetColumns: [row.targetColumn],
        target: row.target,
      });
    } else {
      known.columns.push(row.column);
      known.targetColumns.push(row.targetColumn);
    }
  }
  return [...keys.values()].filter((key): key is NonNullable<typeof key> => key !== null);
}
