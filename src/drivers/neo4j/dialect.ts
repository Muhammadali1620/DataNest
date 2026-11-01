// What DataNest asks a dialect for, in Cypher (V13.21). Neo4j keeps no tables: the tree lists
// labels as tables and relationship types as views, so most of what a SQL dialect writes
// (CREATE TABLE, dumps, INSERT … VALUES) has no meaning here and says so.

import { DbError } from '../../core/errors';
import { KEYWORDS } from '../../core/sql/keywords';
import { msg } from '../../core/user-message';
import { type CellValue, isTaggedValue } from '../../shared/cell-value';
import type { Dialect, DumpDialect, SchemaDdl } from '../driver';
import { quoteName } from './table-query';

export function quoteIdentifier(name: string): string {
  if (name === '') {
    throw new Error(msg('Identifier must not be empty'));
  }
  if (name.includes('\u0000')) {
    throw new Error(msg('Identifier must not contain NUL'));
  }
  return quoteName(name);
}

/** A label is one name; there are no schemas to qualify it with. */
export function quoteTable(table: { readonly name: string }): string {
  return quoteIdentifier(table.name);
}

/** A Cypher string: single quotes, backslash escapes. */
export function quoteString(text: string): string {
  return `'${text.replaceAll('\\', '\\\\').replaceAll("'", "\\'").replaceAll('\n', '\\n').replaceAll('\r', '\\r')}'`;
}

/** Renders a value as a Cypher literal; used only for text the user previews. */
export function literal(value: CellValue): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    if (Number.isNaN(value)) {
      return '(0.0/0.0)';
    }
    if (!Number.isFinite(value)) {
      return value > 0 ? '(1.0/0.0)' : '(-1.0/0.0)';
    }
    return String(value);
  }
  if (typeof value === 'string') {
    return quoteString(value);
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
        return /^-?\d+$/u.test(value.text) ? value.text : quoteString(value.text);
      case 'decimal':
        return /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/u.test(value.text)
          ? value.text
          : quoteString(value.text);
      case 'datetime':
      case 'json':
        return quoteString(value.text);
      case 'binary':
        return quoteString(value.preview);
    }
  }
  return 'null';
}

/** `LIMIT` and `SKIP` end a statement; the table view reads them back (table-query.ts). */
export function paginate(sql: string, limit: number, offset: number): string {
  if (!Number.isInteger(limit) || limit < 0 || !Number.isInteger(offset) || offset < 0) {
    throw new Error(`Invalid page: limit ${limit}, offset ${offset}`);
  }
  const base = sql.replace(/[\s;]+$/u, '');
  return offset === 0 ? `${base} LIMIT ${limit}` : `${base} SKIP ${offset} LIMIT ${limit}`;
}

/** The text of one of our own string literals. */
function unquoted(quoted: string): string {
  const inner = /^'(.*)'$/su.exec(quoted)?.[1] ?? quoted;
  return inner.replace(/\\(.)/gsu, (_all, char: string) => (char === 'n' ? '\n' : char));
}

/**
 * The filter writes LIKE patterns with `%`, `_` and `!` as the escape; a regular expression
 * says the same: `%` is any run, `_` any character, the rest is literal.
 */
export function likeRegex(quotedPattern: string): string {
  const pattern = unquoted(quotedPattern);
  let result = '';
  for (let index = 0; index < pattern.length; index++) {
    const char = pattern[index] ?? '';
    if (char === '!' && index + 1 < pattern.length) {
      index++;
      result += escapeRegex(pattern[index] ?? '');
    } else if (char === '%') {
      result += '.*';
    } else if (char === '_') {
      result += '.';
    } else {
      result += escapeRegex(char);
    }
  }
  return `(?is)${result}`;
}

function escapeRegex(char: string): string {
  return /[\\.[\]{}()*+?^$|]/u.test(char) ? `\\${char}` : char;
}

/** Throws the (already translated) reason a SQL-shaped action means nothing here. */
function unsupported(reason: string): never {
  throw new DbError('unsupported', reason);
}

const ddl: SchemaDdl = {
  createDatabase: (name) => `CREATE DATABASE ${quoteIdentifier(name)}`,
  dropDatabase: (name) => `DROP DATABASE ${quoteIdentifier(name)}`,
  designer: {
    columnComments: false,
    tableComment: false,
    types: [],
    reorder: false,
    autoIncrement: false,
    foreignKeys: false,
    uniqueIndexes: false,
  },
  createTable: () =>
    unsupported(msg('Neo4j has no table designer: a label appears with its first node')),
  alterTable: () =>
    unsupported(msg('Neo4j has no table designer: a label appears with its first node')),
  dropRelation: () => unsupported(msg('A label cannot be dropped: delete its nodes with Cypher')),
  renameRelation: () =>
    unsupported(msg('A label cannot be renamed: change it on the nodes with Cypher')),
  truncateTable: (table) => `MATCH (n:${quoteIdentifier(table.name)}) DETACH DELETE n`,
  dropObject: () => unsupported(msg('Neo4j keeps no routines inside a database')),
  replaceObject: () => unsupported(msg('Neo4j keeps no routines inside a database')),
};

const dump: DumpDialect = {
  prepare: [],
  beginSnapshot: [],
  endSnapshot: [],
  header: [],
  footer: [],
  keysAfterData: false,
  routinesFirst: false,
  insert: () => unsupported(msg('Neo4j has no SQL dump: use apoc.export or neo4j-admin')),
  insertSelect: () => unsupported(msg('Neo4j has no SQL dump: use apoc.export or neo4j-admin')),
  dropRelations: () => [],
  dropObject: () => unsupported(msg('Neo4j keeps no routines inside a database')),
};

export const neo4jDialect: Dialect = {
  keywords: KEYWORDS.neo4j,
  quoteIdentifier,
  quoteTable,
  literal,
  paginate,
  likeText: (quotedColumn, quotedPattern) =>
    `toString(${quotedColumn}) =~ ${quoteString(likeRegex(quotedPattern))}`,
  defaultKeyword: false,
  insertDefaultRow: (quotedTable) => `CREATE (:${quotedTable})`,
  // Every statement is its own transaction (the Query API); these words exist only so the
  // interface is whole.
  transaction: {
    begin: 'BEGIN',
    commit: 'COMMIT',
    rollback: 'ROLLBACK',
    savepoint: () => 'RETURN 1',
    rollbackToSavepoint: () => 'RETURN 1',
  },
  ddl,
  dump,
};
