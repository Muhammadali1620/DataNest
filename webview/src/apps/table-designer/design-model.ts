// Edits of a table design on the page. Every function returns a new design, so the
// component only assigns and never mutates what it renders.

import type { DriverId } from '../../../../src/shared/connection';
import type { ColumnDesign, DesignProblem, TableDesign } from '../../../../src/shared/table-design';
import type { MessageKey } from '../../l10n/en';

/** A new column: nullable text, the most common thing to add. */
export function addColumn(design: TableDesign, driver: DriverId): TableDesign {
  const column: ColumnDesign = {
    id: nextColumnId(design),
    name: '',
    type: driver === 'mysql' ? 'varchar' : 'text',
    length: driver === 'mysql' ? '255' : '',
    nullable: true,
    defaultValue: '',
    autoIncrement: false,
    primaryKey: false,
    comment: '',
  };
  return { ...design, columns: [...design.columns, column] };
}

/** An id no column of this design has, of the form `new-N`. */
export function nextColumnId(design: TableDesign): string {
  let highest = 0;
  for (const column of design.columns) {
    const match = /^new-(\d+)$/.exec(column.id);
    if (match !== null) {
      highest = Math.max(highest, Number(match[1]));
    }
  }
  return `new-${highest + 1}`;
}

export function removeColumn(design: TableDesign, id: string): TableDesign {
  return { ...design, columns: design.columns.filter((column) => column.id !== id) };
}

/** Moves a column up (`-1`) or down (`1`); moving past either end does nothing. */
export function moveColumn(design: TableDesign, id: string, delta: -1 | 1): TableDesign {
  const index = design.columns.findIndex((column) => column.id === id);
  const target = index + delta;
  if (index === -1 || target < 0 || target >= design.columns.length) {
    return design;
  }
  const columns = [...design.columns];
  const [moved] = columns.splice(index, 1);
  if (moved !== undefined) {
    columns.splice(target, 0, moved);
  }
  return { ...design, columns };
}

/**
 * Changes one column and keeps it consistent: a key column cannot be nullable, and
 * an auto-numbered column is a NOT NULL key (PostgreSQL numbers any column, so only
 * NOT NULL is implied there).
 */
export function updateColumn(
  design: TableDesign,
  id: string,
  patch: Partial<Omit<ColumnDesign, 'id' | 'original'>>,
  driver: DriverId,
): TableDesign {
  return {
    ...design,
    columns: design.columns.map((column) => {
      if (column.id !== id) {
        return column;
      }
      const next = { ...column, ...patch };
      if (patch.autoIncrement === true) {
        next.nullable = false;
        if (driver !== 'postgres') {
          next.primaryKey = true;
        }
      }
      if (next.primaryKey) {
        next.nullable = false;
      }
      return next;
    }),
  };
}

/** The message of a problem, in the words of the page dictionary. */
export function problemMessage(problem: DesignProblem): MessageKey {
  switch (problem.kind) {
    case 'table-name':
      return 'designer.problem.tableName';
    case 'no-columns':
      return 'designer.problem.noColumns';
    case 'column-name':
      return 'designer.problem.columnName';
    case 'duplicate-column':
      return 'designer.problem.duplicateColumn';
    case 'column-type':
      return 'designer.problem.columnType';
    case 'auto-increment':
      switch (problem.reason) {
        case 'type':
          return 'designer.problem.autoType';
        case 'key':
          return 'designer.problem.autoKey';
        case 'several':
          return 'designer.problem.autoSeveral';
        case 'default':
          return 'designer.problem.autoDefault';
      }
  }
}

/** Problems that belong to one column, by its id. */
export function columnProblems(problems: readonly DesignProblem[], id: string): DesignProblem[] {
  return problems.filter((problem) => 'column' in problem && problem.column === id);
}
