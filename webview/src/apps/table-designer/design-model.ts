// Edits of a table design on the page. Every function returns a new design, so the
// component only assigns and never mutates what it renders.

import type { DriverId } from '../../../../src/shared/connection';
import type {
  ColumnDesign,
  DesignProblem,
  ForeignKeyDesign,
  IndexDesign,
  TableDesign,
} from '../../../../src/shared/table-design';
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

/**
 * Removes a column and takes it out of every index and key. A key keeps its pairs
 * aligned: the referenced column in the same position goes too.
 */
export function removeColumn(design: TableDesign, id: string): TableDesign {
  return {
    ...design,
    columns: design.columns.filter((column) => column.id !== id),
    indexes: design.indexes.map((index) =>
      index.columns.includes(id)
        ? { ...index, columns: index.columns.filter((column) => column !== id) }
        : index,
    ),
    foreignKeys: design.foreignKeys.map((key) => {
      const position = key.columns.indexOf(id);
      if (position === -1) {
        return key;
      }
      return {
        ...key,
        columns: key.columns.filter((_, at) => at !== position),
        targetColumns: key.targetColumns.filter((_, at) => at !== position),
      };
    }),
  };
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

/** The next free number for a generated name or id with this prefix. */
function nextNumber(values: readonly string[], prefix: string): number {
  let highest = 0;
  for (const value of values) {
    if (value.startsWith(prefix)) {
      const number = Number(value.slice(prefix.length));
      if (Number.isInteger(number)) {
        highest = Math.max(highest, number);
      }
    }
  }
  return highest + 1;
}

/** `orders` → `orders`; an unnamed table still gets readable names. */
function stem(design: TableDesign): string {
  const name = design.name.trim().replace(/\s+/g, '_');
  return name === '' ? 'table' : name;
}

export function addIndex(design: TableDesign): TableDesign {
  const prefix = `ix_${stem(design)}_`;
  const index: IndexDesign = {
    id: `index-${nextNumber(
      design.indexes.map((item) => item.id),
      'index-',
    )}`,
    name: `${prefix}${nextNumber(
      design.indexes.map((item) => item.name),
      prefix,
    )}`,
    columns: [],
    unique: false,
  };
  return { ...design, indexes: [...design.indexes, index] };
}

export function updateIndex(
  design: TableDesign,
  id: string,
  patch: Partial<Omit<IndexDesign, 'id' | 'original'>>,
): TableDesign {
  return {
    ...design,
    indexes: design.indexes.map((index) => (index.id === id ? { ...index, ...patch } : index)),
  };
}

export function removeIndex(design: TableDesign, id: string): TableDesign {
  return { ...design, indexes: design.indexes.filter((index) => index.id !== id) };
}

export function addForeignKey(design: TableDesign): TableDesign {
  const prefix = `fk_${stem(design)}_`;
  const key: ForeignKeyDesign = {
    id: `key-${nextNumber(
      design.foreignKeys.map((item) => item.id),
      'key-',
    )}`,
    name: `${prefix}${nextNumber(
      design.foreignKeys.map((item) => item.name),
      prefix,
    )}`,
    columns: [],
    targetTable: '',
    targetColumns: [],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
  };
  return { ...design, foreignKeys: [...design.foreignKeys, key] };
}

/**
 * Changing the referenced table empties the referenced columns, which belonged to the
 * old one, unless the same change brings new ones.
 */
export function updateForeignKey(
  design: TableDesign,
  id: string,
  patch: Partial<Omit<ForeignKeyDesign, 'id' | 'original'>>,
): TableDesign {
  return {
    ...design,
    foreignKeys: design.foreignKeys.map((key) => {
      if (key.id !== id) {
        return key;
      }
      const next = { ...key, ...patch };
      const tableChanged = patch.targetTable !== undefined && patch.targetTable !== key.targetTable;
      return tableChanged && patch.targetColumns === undefined
        ? { ...next, targetColumns: [] }
        : next;
    }),
  };
}

export function removeForeignKey(design: TableDesign, id: string): TableDesign {
  return { ...design, foreignKeys: design.foreignKeys.filter((key) => key.id !== id) };
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
    case 'index-name':
    case 'key-name':
      return 'designer.problem.indexName';
    case 'duplicate-index':
    case 'duplicate-key':
      return 'designer.problem.duplicateIndex';
    case 'index-columns':
    case 'key-columns':
      return 'designer.problem.indexColumns';
    case 'key-target':
      return 'designer.problem.keyTarget';
    case 'key-target-columns':
      return 'designer.problem.keyTargetColumns';
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

/** Problems of one index, by its id. */
export function indexProblems(problems: readonly DesignProblem[], id: string): DesignProblem[] {
  return problems.filter((problem) => 'index' in problem && problem.index === id);
}

/** Problems of one foreign key, by its id. */
export function keyProblems(problems: readonly DesignProblem[], id: string): DesignProblem[] {
  return problems.filter((problem) => 'key' in problem && problem.key === id);
}
