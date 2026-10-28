// One-line texts the tree shows next to names: column types, index keys, where a
// foreign key points. Free of `vscode` so the wording is unit-tested.

import type { ColumnInfo, ForeignKey, IndexInfo, ObjectRef } from '../../core/model/objects';

/** One-line summary of an index: its kind and key parts. */
export function describeIndex(index: IndexInfo): string {
  const kind = index.primary ? 'PRIMARY KEY' : index.unique ? 'UNIQUE' : '';
  const method = index.method === undefined ? '' : index.method.toLowerCase();
  const head = [kind, method === 'btree' ? '' : method].filter((part) => part !== '').join(' ');
  const parts = `(${index.columns.join(', ')})`;
  const where = index.where === undefined ? '' : ` WHERE ${index.where}`;
  return head === '' ? `${parts}${where}` : `${head} ${parts}${where}`;
}

/** One-line summary of a foreign key: its columns and where they point. */
export function describeForeignKey(key: ForeignKey): string {
  const target = [key.target.database, key.target.schema, key.target.name]
    .filter((part) => part !== undefined)
    .join('.');
  return `(${key.columns.join(', ')}) → ${target} (${key.targetColumns.join(', ')})`;
}

/** The label of a routine: overloads show their arguments. */
export function objectLabel(object: ObjectRef): string {
  return object.signature === undefined ? object.name : `${object.name}(${object.signature})`;
}

/** One-line summary of a column: type, key and nullability. */
export function describeColumn(column: ColumnInfo): string {
  const parts = [column.dataType];
  if (column.primaryKey) {
    parts.push('PK');
  }
  if (!column.nullable) {
    parts.push('NOT NULL');
  }
  if (column.defaultValue !== undefined) {
    parts.push(`DEFAULT ${column.defaultValue}`);
  }
  return parts.join(', ');
}
