// Structure changes in ClickHouse. A table needs an engine and a sorting key; designed
// tables get MergeTree ordered by the primary key columns (or by nothing). Nothing here
// is transactional: an ALTER runs change by change, and what ran stays.

import { DbError } from '../../core/errors';
import type { ObjectRef, RelationKind, TableRef } from '../../core/model/objects';
import {
  type ColumnDesign,
  columnNames,
  composeType,
  type IndexDesign,
  type TableBackground,
  type TableDesign,
} from '../../shared/table-design';
import { diffTables, isEmptyDiff } from '../../shared/table-diff';
import { type AlterPlan, EMPTY_PLAN, type SchemaDdl } from '../driver';
import { quoteIdentifier, quoteString, quoteTable } from './quote';

const TYPES = [
  'UInt8',
  'UInt16',
  'UInt32',
  'UInt64',
  'Int8',
  'Int16',
  'Int32',
  'Int64',
  'Float32',
  'Float64',
  'Decimal',
  'Bool',
  'String',
  'FixedString',
  'LowCardinality(String)',
  'UUID',
  'Date',
  'Date32',
  'DateTime',
  'DateTime64',
  'Enum8',
  'IPv4',
  'IPv6',
  'Array(String)',
  'Map(String, String)',
  'JSON',
];

/** Types that hold several values and cannot be wrapped in Nullable. */
const COMPOSITE = /^(Array|Map|Tuple|Nested|JSON|Object|Variant|Dynamic)\b/iu;

/** The type a column of the design is stored as: nullable columns become Nullable(…). */
export function storedType(column: ColumnDesign): string {
  const type = composeType(column.type, column.length);
  if (!column.nullable || column.primaryKey || COMPOSITE.test(type) || /^Nullable\(/iu.test(type)) {
    return type;
  }
  const low = /^LowCardinality\((.*)\)$/isu.exec(type);
  return low === null ? `Nullable(${type})` : `LowCardinality(Nullable(${low[1] ?? ''}))`;
}

/** `` `name` Type [DEFAULT expr] [COMMENT '…'] ``. */
export function clickhouseColumnSql(column: ColumnDesign): string {
  const pieces = [quoteIdentifier(column.name.trim()), storedType(column)];
  if (column.defaultValue.trim() !== '') {
    pieces.push(`DEFAULT ${column.defaultValue.trim()}`);
  }
  if (column.comment !== '') {
    pieces.push(`COMMENT ${quoteString(column.comment)}`);
  }
  return pieces.join(' ');
}

/** A data skipping index: the designer offers no kind, and bloom filters suit most columns. */
function indexSql(design: TableDesign, index: IndexDesign): string {
  const columns = columnNames(design, index.columns).map(quoteIdentifier);
  const expression = columns.length === 1 ? (columns[0] ?? '') : `(${columns.join(', ')})`;
  return `INDEX ${quoteIdentifier(index.name.trim())} ${expression} TYPE bloom_filter GRANULARITY 4`;
}

function orderBy(design: TableDesign): string {
  const keys = design.columns
    .filter((column) => column.primaryKey)
    .map((column) => quoteIdentifier(column.name.trim()));
  return keys.length === 0 ? 'tuple()' : `(${keys.join(', ')})`;
}

const RELATION_WORDS: Readonly<Record<RelationKind, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  'materialized-view': 'VIEW',
};

export const clickhouseDdl: SchemaDdl = {
  createDatabase: (name) => `CREATE DATABASE ${quoteIdentifier(name)}`,
  dropDatabase: (name) => `DROP DATABASE ${quoteIdentifier(name)}`,
  designer: {
    columnComments: true,
    tableComment: true,
    types: TYPES,
    reorder: true,
    autoIncrement: false,
    foreignKeys: false,
    uniqueIndexes: false,
  },
  createTable: (table, design) => {
    const target = quoteTable({ ...table, name: design.name.trim() });
    const items = [
      ...design.columns.map(clickhouseColumnSql),
      ...design.indexes.filter((index) => !index.unique).map((index) => indexSql(design, index)),
    ];
    const comment = design.comment === '' ? '' : `\nCOMMENT ${quoteString(design.comment)}`;
    return [
      `CREATE TABLE ${target} (\n${items.map((item) => `  ${item}`).join(',\n')}\n)\nENGINE = MergeTree\nORDER BY ${orderBy(design)}${comment}`,
    ];
  },
  alterTable: clickhouseAlterTable,
  dropRelation: (table, kind) => `DROP ${RELATION_WORDS[kind]} ${quoteTable(table)}`,
  renameRelation: (table, _kind, newName) =>
    `RENAME TABLE ${quoteTable(table)} TO ${quoteTable({ ...table, name: newName })}`,
  truncateTable: (table) => `TRUNCATE TABLE ${quoteTable(table)}`,
  dropObject: (object: ObjectRef) => {
    switch (object.kind) {
      case 'table':
      case 'view':
        return `DROP ${RELATION_WORDS[object.kind]} ${quoteTable(object)}`;
      case 'function':
        // SQL functions belong to the whole server.
        return `DROP FUNCTION ${quoteIdentifier(object.name)}`;
      case 'procedure':
      case 'trigger':
      case 'sequence':
      case 'event':
        throw new DbError('unsupported', `ClickHouse has no ${object.kind}`);
    }
  },
  replaceObject: (object, statements, original) => {
    if (object.kind !== 'view') {
      throw new DbError('unsupported', `A ${object.kind} is not edited as a definition`);
    }
    if (object.materialized === true) {
      // No OR REPLACE for materialized views: dropped and made again, and made as before
      // when the new text fails. Its stored rows are gone either way.
      return {
        check: [],
        statements: [`DROP VIEW IF EXISTS ${quoteTable(object)}`, ...statements],
        recovery: [...original],
      };
    }
    return {
      check: [],
      statements: statements.map((sql) =>
        sql.replace(/^(\s*)CREATE\s+VIEW\b/iu, '$1CREATE OR REPLACE VIEW'),
      ),
      recovery: [],
    };
  },
};

/** The column a moved or added column follows in the new order, or FIRST. */
function placement(after: TableDesign, column: ColumnDesign): string {
  const index = after.columns.findIndex((candidate) => candidate.id === column.id);
  const previous = after.columns[index - 1];
  return previous === undefined ? 'FIRST' : `AFTER ${quoteIdentifier(previous.name.trim())}`;
}

export function clickhouseAlterTable(
  table: TableRef,
  before: TableDesign,
  after: TableDesign,
  background: TableBackground,
): AlterPlan {
  const diff = diffTables(before, after);
  if (isEmptyDiff(diff)) {
    return EMPTY_PLAN;
  }
  if (diff.primaryKey) {
    throw new DbError(
      'unsupported',
      'The sorting key of a ClickHouse table cannot change; copy the rows into a new table instead',
    );
  }
  const target = quoteTable(table);
  const alter = (clause: string): string => `ALTER TABLE ${target} ${clause}`;
  const q = quoteIdentifier;
  const statements: string[] = [];

  for (const index of diff.droppedIndexes) {
    if (!background.fixedIndexes.some((fixed) => fixed.name === (index.original ?? index.name))) {
      statements.push(alter(`DROP INDEX ${q(index.original ?? index.name)}`));
    }
  }
  for (const column of diff.dropped) {
    statements.push(alter(`DROP COLUMN ${q(column.original ?? column.name)}`));
  }
  for (const change of diff.changed) {
    const { before: old, after: next } = change;
    const name = q(next.name.trim());
    if (change.renamed) {
      statements.push(alter(`RENAME COLUMN ${q(old.original ?? old.name)} TO ${name}`));
    }
    if (change.type || change.nullable) {
      statements.push(alter(`MODIFY COLUMN ${name} ${storedType(next)}`));
    }
    if (change.defaultValue) {
      statements.push(
        alter(
          next.defaultValue.trim() === ''
            ? `MODIFY COLUMN ${name} REMOVE DEFAULT`
            : `MODIFY COLUMN ${name} DEFAULT ${next.defaultValue.trim()}`,
        ),
      );
    }
    if (change.comment) {
      statements.push(alter(`COMMENT COLUMN ${name} ${quoteString(next.comment)}`));
    }
  }
  for (const column of diff.added) {
    statements.push(alter(`ADD COLUMN ${clickhouseColumnSql(column)} ${placement(after, column)}`));
  }
  if (diff.order) {
    const added = new Set(diff.added.map((column) => column.id));
    // MODIFY COLUMN needs the type before FIRST or AFTER; the same type changes nothing.
    for (const column of after.columns.filter((candidate) => !added.has(candidate.id))) {
      statements.push(
        alter(
          `MODIFY COLUMN ${q(column.name.trim())} ${storedType(column)} ${placement(after, column)}`,
        ),
      );
    }
  }
  for (const index of diff.addedIndexes.filter((candidate) => !candidate.unique)) {
    statements.push(alter(`ADD ${indexSql(after, index)}`));
  }
  if (diff.comment) {
    statements.push(alter(`MODIFY COMMENT ${quoteString(after.comment)}`));
  }
  if (diff.renamed) {
    statements.push(
      `RENAME TABLE ${target} TO ${quoteTable({ ...table, name: after.name.trim() })}`,
    );
  }
  return { statements, notes: [], recovery: [] };
}
