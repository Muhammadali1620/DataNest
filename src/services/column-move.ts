// Moving a column one place up or down from the tree (V11.12): the table as the
// designer would load it, with the column swapped with its neighbour, as an `alterTable`
// action. The dialect writes the statements (MySQL `AFTER`, a SQLite rebuild) and the
// usual confirm-and-run flow shows them first.

import { DbError } from '../core/errors';
import type { TableRef } from '../core/model/objects';
import { msg } from '../core/user-message';
import type { SchemaAction } from './schema-actions';
import { designFromStructure } from './table-structure';
import type { TableStructure } from '../core/model/objects';

export type MoveDirection = 'up' | 'down';

/**
 * The action that moves `column`; undefined when it already is first (up) or last (down).
 * A generated column is not in the design, so it cannot be moved from here.
 */
export function planColumnMove(
  table: TableRef,
  structure: TableStructure,
  column: string,
  direction: MoveDirection,
): Extract<SchemaAction, { kind: 'alterTable' }> | undefined {
  const { design, background } = designFromStructure(table, structure);
  const from = design.columns.findIndex((candidate) => candidate.original === column);
  if (from < 0) {
    throw new DbError('unsupported', msg('The column "{0}" cannot be moved from here', column));
  }
  const to = direction === 'up' ? from - 1 : from + 1;
  const moved = design.columns[from];
  const neighbour = design.columns[to];
  if (moved === undefined || neighbour === undefined) {
    return undefined;
  }
  const columns = [...design.columns];
  columns[from] = neighbour;
  columns[to] = moved;
  return { kind: 'alterTable', table, before: design, after: { ...design, columns }, background };
}
