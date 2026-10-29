// An existing table as the designer edits it: the structure the driver read becomes
// a TableDesign (what the user may change) and a TableBackground (what the designer
// keeps intact and shows as is).

import type { IndexInfo, TableRef, TableStructure } from '../core/model/objects';
import {
  type ColumnDesign,
  type ForeignKeyDesign,
  type IndexDesign,
  REFERENTIAL_ACTIONS,
  type ReferentialAction,
  splitType,
  type TableBackground,
  type TableDesign,
} from '../shared/table-design';

export interface LoadedTable {
  readonly design: TableDesign;
  readonly background: TableBackground;
}

function action(value: string | undefined): ReferentialAction {
  const upper = value?.toUpperCase().trim();
  return REFERENTIAL_ACTIONS.find((known) => known === upper) ?? 'NO ACTION';
}

/** Index methods the designer writes by default; any other is kept as is. */
/**
 * Index kinds the designer edits: B-trees (MySQL, PostgreSQL), SQL Server's nonclustered
 * indexes, and the bloom filters it creates in ClickHouse. Others are kept as they are.
 */
const PLAIN_METHODS = new Set(['btree', 'nonclustered', 'bloom_filter']);

function describe(index: IndexInfo): string {
  const kind = [index.unique ? 'UNIQUE' : '', index.method ?? ''].filter((p) => p !== '').join(' ');
  const where = index.where === undefined ? '' : ` WHERE ${index.where}`;
  return `${kind === '' ? '' : `${kind} `}(${index.columns.join(', ')})${where}`;
}

/**
 * `table` is where the table lives; a foreign key into the same database or schema
 * leaves `targetSchema` out, so the design reads like one typed by hand.
 */
export function designFromStructure(table: TableRef, structure: TableStructure): LoadedTable {
  const columns: ColumnDesign[] = [];
  const generatedColumns: string[] = [];
  const idByName = new Map<string, string>();
  structure.columns.forEach((column, position) => {
    if (column.generated) {
      generatedColumns.push(column.name);
      return;
    }
    const id = `col-${position + 1}`;
    const primaryKey = structure.primaryKey.includes(column.name);
    idByName.set(column.name, id);
    columns.push({
      id,
      original: column.name,
      name: column.name,
      ...splitType(column.dataType),
      // The designer writes every key column NOT NULL; SQLite reports its INTEGER
      // PRIMARY KEY as nullable although it can never hold NULL.
      nullable: column.nullable && !primaryKey,
      defaultValue: column.defaultExpression ?? '',
      autoIncrement: column.autoIncrement,
      primaryKey,
      comment: column.comment ?? '',
    });
  });

  const indexes: IndexDesign[] = [];
  const fixedIndexes: { name: string; description: string }[] = [];
  const constraintIndexes: string[] = [];
  for (const index of structure.indexes) {
    if (index.primary) {
      continue;
    }
    if (index.constraint === true || index.name.startsWith('sqlite_autoindex_')) {
      constraintIndexes.push(index.name);
    }
    const ids = index.columns.map((name) => idByName.get(name));
    const plain =
      index.where === undefined &&
      (index.method === undefined || PLAIN_METHODS.has(index.method.toLowerCase())) &&
      ids.every((id) => id !== undefined);
    if (!plain) {
      fixedIndexes.push({ name: index.name, description: describe(index) });
      continue;
    }
    indexes.push({
      id: `index-${indexes.length + 1}`,
      original: index.name,
      // SQLite reserves the names of its automatic indexes: a rebuild that creates the
      // index on its own gives it a name of the usual kind instead.
      name: index.name.startsWith('sqlite_autoindex_')
        ? `uq_${table.name}_${index.columns.join('_')}`
        : index.name,
      columns: ids,
      unique: index.unique,
    });
  }

  const own = table.schema ?? table.database;
  const foreignKeys: ForeignKeyDesign[] = structure.foreignKeys.flatMap((key, position) => {
    const ids = key.columns.map((name) => idByName.get(name));
    if (ids.some((id) => id === undefined)) {
      return [];
    }
    const targetScope = key.target.schema ?? key.target.database;
    return [
      {
        id: `key-${position + 1}`,
        original: key.name,
        name: key.name,
        columns: ids.filter((id): id is string => id !== undefined),
        ...(targetScope === undefined || targetScope === own ? {} : { targetSchema: targetScope }),
        targetTable: key.target.name,
        targetColumns: [...key.targetColumns],
        onDelete: action(key.onDelete),
        onUpdate: action(key.onUpdate),
      },
    ];
  });

  // What a SQLite rebuild recreates by hand: triggers, and indexes the design leaves out.
  const designed = new Set(indexes.map((index) => index.original));
  const rebuildSql = (structure.dependents ?? [])
    .filter((dependent) => dependent.kind === 'trigger' || !designed.has(dependent.name))
    .map((dependent) => dependent.sql);

  return {
    design: {
      name: table.name,
      comment: structure.comment ?? '',
      columns,
      indexes,
      foreignKeys,
    },
    background: {
      ...(structure.primaryKeyName === undefined
        ? {}
        : { primaryKeyName: structure.primaryKeyName }),
      fixedIndexes,
      generatedColumns,
      constraintIndexes,
      rebuildSql,
    },
  };
}
