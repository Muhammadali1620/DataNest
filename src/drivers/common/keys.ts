import type { ForeignKey, IndexInfo, TableRef } from '../../core/model/objects';

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
  readonly onDelete?: string | undefined;
  readonly onUpdate?: string | undefined;
}

/**
 * Column pairs grouped into keys. A constraint with a missing name part is dropped
 * whole, because half a key would send the user to the wrong row.
 */
export function groupForeignKeys(rows: readonly ForeignKeyRow[]): ForeignKey[] {
  const keys = new Map<
    string,
    {
      name: string;
      columns: string[];
      targetColumns: string[];
      target: TableRef;
      onDelete?: string;
      onUpdate?: string;
    } | null
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
        ...(row.onDelete === undefined ? {} : { onDelete: row.onDelete }),
        ...(row.onUpdate === undefined ? {} : { onUpdate: row.onUpdate }),
      });
    } else {
      known.columns.push(row.column);
      known.targetColumns.push(row.targetColumn);
    }
  }
  return [...keys.values()].filter((key): key is NonNullable<typeof key> => key !== null);
}

/** One row of an index listing: a key part of one index. */
export interface IndexRow {
  readonly name: string | undefined;
  /** The column, or undefined for an expression the server does not print. */
  readonly column: string | undefined;
  readonly unique: boolean;
  readonly primary: boolean;
  readonly method?: string;
  readonly where?: string;
  readonly constraint?: boolean;
}

/** Shown for a key part that is an expression rather than a column. */
export const EXPRESSION_PART = '(expression)';

/** Key parts grouped into indexes, keeping the order rows arrive in. */
export function groupIndexes(rows: readonly IndexRow[]): IndexInfo[] {
  const indexes = new Map<string, { info: IndexInfo; columns: string[] }>();
  for (const row of rows) {
    if (row.name === undefined) {
      continue;
    }
    let entry = indexes.get(row.name);
    if (entry === undefined) {
      const columns: string[] = [];
      entry = {
        columns,
        info: {
          name: row.name,
          columns,
          unique: row.unique || row.primary,
          primary: row.primary,
          ...(row.method === undefined || row.method === '' ? {} : { method: row.method }),
          ...(row.where === undefined || row.where === '' ? {} : { where: row.where }),
          ...(row.constraint === true ? { constraint: true } : {}),
        },
      };
      indexes.set(row.name, entry);
    }
    entry.columns.push(row.column ?? EXPRESSION_PART);
  }
  return [...indexes.values()].map((entry) => entry.info);
}
