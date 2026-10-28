// Replacing a view, routine, trigger or event in MySQL. DDL there cannot be rolled
// back, so a routine or trigger is first created under a scratch name: if the server
// refuses the new text (syntax, missing privilege), nothing has been dropped yet.

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import { isTrivia, syntaxOf, textOf, tokenize } from '../../core/sql/tokenizer';
import type { ReplacePlan } from '../driver';
import { quoteIdentifier, quoteTable } from './quote';

const KEYWORDS = {
  procedure: 'PROCEDURE',
  function: 'FUNCTION',
  trigger: 'TRIGGER',
  event: 'EVENT',
} as const;

/** Suffix of the scratch object that proves a new definition is accepted. */
export const CHECK_SUFFIX = '__datanest_check';

function qualified(object: ObjectRef, name = object.name): string {
  return quoteTable(object.database === undefined ? { name } : { database: object.database, name });
}

/**
 * The CREATE statement with the created object's name replaced, or undefined when
 * the text does not create a `keyword` object where expected.
 */
export function renameCreated(sql: string, keyword: string, name: string): string | undefined {
  const tokens = tokenize(sql, syntaxOf('mysql')).filter((token) => !isTrivia(token));
  const words = tokens.map((token) => textOf(sql, token).toUpperCase());
  if (words[0] !== 'CREATE') {
    return undefined;
  }
  let index = words.indexOf(keyword);
  if (index === -1) {
    return undefined;
  }
  index += 1;
  if (words[index] === 'IF' && words[index + 1] === 'NOT' && words[index + 2] === 'EXISTS') {
    index += 3;
  }
  let last = tokens[index];
  if (last === undefined || (last.kind !== 'word' && last.kind !== 'quoted-identifier')) {
    return undefined;
  }
  // `db`.`name`: the part after the dot is the name.
  const dot = tokens[index + 1];
  const qualifiedName = tokens[index + 2];
  if (dot !== undefined && textOf(sql, dot) === '.' && qualifiedName !== undefined) {
    last = qualifiedName;
  }
  return `${sql.slice(0, last.start)}${quoteIdentifier(name)}${sql.slice(last.end)}`;
}

/** `CREATE VIEW` becomes `CREATE OR REPLACE VIEW`, which swaps the view in one step. */
export function orReplace(sql: string): string {
  return /^\s*CREATE\s+OR\s+REPLACE\b/i.test(sql)
    ? sql
    : sql.replace(/^(\s*CREATE)\b/i, '$1 OR REPLACE');
}

export function mysqlReplaceObject(
  object: ObjectRef,
  statements: readonly string[],
  original: readonly string[],
): ReplacePlan {
  if (object.kind === 'view') {
    return { check: [], statements: statements.map((sql) => orReplace(sql)), recovery: [] };
  }
  if (
    object.kind !== 'procedure' &&
    object.kind !== 'function' &&
    object.kind !== 'trigger' &&
    object.kind !== 'event'
  ) {
    throw new DbError('unsupported', `A ${object.kind} is not edited as a definition`);
  }
  const keyword = KEYWORDS[object.kind];
  const drop = `DROP ${keyword} IF EXISTS ${qualified(object)}`;
  const scratch = `${object.name}${CHECK_SUFFIX}`;
  // An event is not tried out: a scratch copy could fire before it is dropped.
  const created =
    object.kind === 'event' || statements.length !== 1
      ? undefined
      : renameCreated(statements[0] ?? '', keyword, scratch);
  return {
    check:
      created === undefined
        ? []
        : [created, `DROP ${keyword} IF EXISTS ${qualified(object, scratch)}`],
    statements: [drop, ...statements],
    recovery: [drop, ...original],
  };
}
