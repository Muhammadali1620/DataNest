// Small schemas for comparison tests (V8.3): table structures written in a line each,
// and snapshots made from them the way readSchemaSnapshot makes them.

import type {
  ColumnDetail,
  ForeignKey,
  IndexInfo,
  ObjectRef,
  ObjectScope,
  TableStructure,
} from '../../src/core/model/objects';
import type { SchemaSnapshot } from '../../src/services/schema-compare/snapshot';
import { designFromStructure } from '../../src/services/table-structure';

/** `name type`, `?` for nullable, `*` for the primary key. */
export function structure(
  columns: string[],
  extra: {
    indexes?: IndexInfo[];
    foreignKeys?: ForeignKey[];
    comment?: string;
    generated?: string[];
  } = {},
): TableStructure {
  const details: ColumnDetail[] = columns.map((spec) => {
    const [name = '', type = 'int'] = spec.replace(/[?*]/gu, '').split(' ');
    return {
      name,
      dataType: type,
      nullable: spec.includes('?'),
      autoIncrement: false,
      generated: extra.generated?.includes(name) ?? false,
    };
  });
  return {
    ...(extra.comment === undefined ? {} : { comment: extra.comment }),
    columns: details,
    primaryKey: columns
      .filter((spec) => spec.includes('*'))
      .map((spec) => spec.split(' ')[0] ?? ''),
    indexes: extra.indexes ?? [],
    foreignKeys: extra.foreignKeys ?? [],
  };
}

export function snapshot(
  scope: ObjectScope,
  tables: Record<string, TableStructure>,
  objects: {
    ref: Omit<ObjectRef, keyof ObjectScope>;
    statements?: string[];
    hidden?: string;
  }[] = [],
): SchemaSnapshot {
  return {
    scope,
    tables: Object.entries(tables).map(([name, table]) => ({
      name,
      structure: table,
      loaded: designFromStructure({ ...scope, name }, table),
    })),
    objects: objects.map((object) => ({
      ref: { ...scope, ...object.ref },
      ...(object.statements === undefined ? {} : { statements: object.statements }),
      ...(object.hidden === undefined ? {} : { hidden: object.hidden }),
    })),
  };
}
