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

/** What a column holds, for the icon in the tree. */
export type ColumnKind =
  | 'number'
  | 'text'
  | 'datetime'
  | 'boolean'
  | 'json'
  | 'binary'
  | 'uuid'
  | 'choice'
  | 'geometry'
  | 'other';

/** The kind of a type as a server prints it (`varchar(100)`, `timestamp without time zone`). */
export function columnKind(dataType: string): ColumnKind {
  const type = dataType.trim().toLowerCase();
  const word = /^[a-z_ ]+/u.exec(type)?.[0]?.trim() ?? '';
  if (/^(bool|boolean|bit)$/u.test(word) && !/\bvarying\b/u.test(type)) {
    return 'boolean';
  }
  if (type.startsWith('tinyint(1)')) {
    return 'boolean';
  }
  if (word.includes('uuid') || word.includes('uniqueidentifier')) {
    return 'uuid';
  }
  if (word.includes('json')) {
    return 'json';
  }
  if (/^(enum|set)\b/u.test(word)) {
    return 'choice';
  }
  if (/geometry|geography|point|polygon|linestring/u.test(word)) {
    return 'geometry';
  }
  if (/date|time|interval|year/u.test(word)) {
    return 'datetime';
  }
  if (/blob|binary|bytea|image|raw/u.test(word)) {
    return 'binary';
  }
  if (/char|text|string|clob|xml|name\b/u.test(word)) {
    return 'text';
  }
  if (/int|serial|numeric|decimal|number|float|double|real|money|dec\b/u.test(word)) {
    return 'number';
  }
  return 'other';
}

/** One-line summary of an account or role: its flags, and the roles it is in. */
export function describeAccount(user: {
  readonly flags: readonly string[];
  readonly login: boolean;
  readonly role: boolean;
}): string {
  return [...user.flags, ...(user.login || user.role ? [] : ['no login'])].join(', ');
}
