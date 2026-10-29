// What the word under the cursor names: a table of the statement (by name or alias),
// a column of one, a CTE, or a routine being called. Hover and Go to Definition both
// start here; free of `vscode`, so the reading of SQL is unit-tested.

import type { ObjectRef, ObjectScope, TableRef } from '../../core/model/objects';
import { tableMentions, type TableMention, unquote } from '../../core/sql/completion-context';
import { type DerivedTable, derivedTables } from '../../core/sql/derived-tables';
import { functionsOf } from '../../core/sql/functions';
import { keywordsOf } from '../../core/sql/keywords';
import { statementAt } from '../../core/sql/split';
import { isTrivia, syntaxOf, textOf, tokenize, type Token } from '../../core/sql/tokenizer';
import type { DriverId } from '../../shared/connection';

export type SqlSymbol =
  | { readonly kind: 'table'; readonly table: TableRef }
  /** A column of a known table. */
  | { readonly kind: 'column'; readonly table: TableRef; readonly column: string }
  /** A column whose table is one of these: the statement does not say which. */
  | { readonly kind: 'loose-column'; readonly tables: readonly TableRef[]; readonly column: string }
  | { readonly kind: 'cte'; readonly derived: DerivedTable }
  | { readonly kind: 'routine'; readonly name: string; readonly scope: ObjectScope };

export interface SymbolAt {
  readonly symbol: SqlSymbol;
  /** The word's place in the text, for the hover range. */
  readonly start: number;
  readonly end: number;
}

function isName(token: Token | undefined): boolean {
  return token !== undefined && (token.kind === 'word' || token.kind === 'quoted-identifier');
}

/** The table a mention points at, in the scope of the document. */
function refOf(mention: TableMention, scope: ObjectScope): TableRef {
  return {
    ...scope,
    ...(mention.database === undefined ? {} : { database: mention.database }),
    ...(mention.schema === undefined ? {} : { schema: mention.schema }),
    name: mention.name,
  };
}

/** Where `x.name` makes x a schema (PostgreSQL, SQL Server) rather than a database. */
function schemaQualified(driver: DriverId | undefined): boolean {
  return driver === 'postgres' || driver === 'mssql';
}

/** `x.name`: x is a schema in PostgreSQL and SQL Server, a database elsewhere. */
function qualifiedRef(
  qualifier: string,
  name: string,
  scope: ObjectScope,
  driver: DriverId | undefined,
): TableRef {
  return schemaQualified(driver)
    ? { ...scope, schema: qualifier, name }
    : { ...scope, database: qualifier, name };
}

export function symbolAt(
  sql: string,
  offset: number,
  driver: DriverId | undefined,
  scope: ObjectScope,
): SymbolAt | undefined {
  const all = tokenize(sql, syntaxOf(driver));
  const index = all.findIndex(
    (token) => isName(token) && token.start <= offset && offset <= token.end,
  );
  const token = all[index];
  if (token === undefined) {
    return undefined;
  }
  const significant = (from: number, step: 1 | -1): Token | undefined => {
    for (let at = from + step; at >= 0 && at < all.length; at += step) {
      const candidate = all[at];
      if (candidate !== undefined && !isTrivia(candidate)) {
        return candidate;
      }
    }
    return undefined;
  };
  const text = textOf(sql, token);
  const name = unquote(text);
  const next = significant(index, 1);
  const previous = significant(index, -1);
  const qualifierToken =
    previous !== undefined && textOf(sql, previous) === '.'
      ? significant(all.indexOf(previous), -1)
      : undefined;
  const qualifier =
    qualifierToken !== undefined && isName(qualifierToken)
      ? unquote(textOf(sql, qualifierToken))
      : undefined;
  const at = (symbol: SqlSymbol): SymbolAt => ({ symbol, start: token.start, end: token.end });

  // A call: a routine, unless it is a built-in function or a keyword like IN (…).
  if (next !== undefined && textOf(sql, next) === '(' && token.kind === 'word') {
    const upper = name.toUpperCase();
    const builtin =
      functionsOf(driver).some((fn) => fn.name === upper) || keywordsOf(driver).includes(upper);
    if (builtin) {
      return undefined;
    }
    return at({
      kind: 'routine',
      name,
      scope:
        qualifier === undefined
          ? scope
          : schemaQualified(driver)
            ? { ...scope, schema: qualifier }
            : { ...scope, database: qualifier },
    });
  }
  // Keywords name nothing; a quoted word always names something.
  if (token.kind === 'word' && keywordsOf(driver).includes(name.toUpperCase())) {
    return undefined;
  }

  const statement = statementAt(sql, offset, driver);
  const statementTokens =
    statement === undefined
      ? []
      : all.filter((t) => t.start >= statement.start && t.end <= statement.end);
  const mentions = tableMentions(sql, statementTokens);
  const derived = derivedTables(sql, statementTokens);
  const lower = name.toLowerCase();
  const byAlias = (word: string) =>
    mentions.find((m) => m.alias?.toLowerCase() === word.toLowerCase()) ??
    mentions.find((m) => m.alias === undefined && m.name.toLowerCase() === word.toLowerCase());
  const derivedNamed = (word: string) =>
    derived.find((table) => table.name.toLowerCase() === word.toLowerCase());

  if (qualifier !== undefined) {
    const owner = byAlias(qualifier);
    const ownDerived = derivedNamed(qualifier);
    if (ownDerived !== undefined && (owner === undefined || owner.name === ownDerived.name)) {
      return at({ kind: 'cte', derived: ownDerived });
    }
    if (owner !== undefined) {
      return at({ kind: 'column', table: refOf(owner, scope), column: name });
    }
    // `schema.table` (or `db.table`) written out in full.
    return at({ kind: 'table', table: qualifiedRef(qualifier, name, scope, driver) });
  }

  const own = derivedNamed(name);
  if (own !== undefined) {
    return at({ kind: 'cte', derived: own });
  }
  const mention = byAlias(name) ?? mentions.find((m) => m.name.toLowerCase() === lower);
  if (mention !== undefined) {
    return at({ kind: 'table', table: refOf(mention, scope) });
  }
  const tables = mentions
    .filter((m) => derivedNamed(m.name) === undefined)
    .map((m) => refOf(m, scope));
  // Not a table of the statement: a column of one of them, or a table it does not mention.
  return at(
    tables.length === 0
      ? { kind: 'table', table: { ...scope, name } }
      : { kind: 'loose-column', tables, column: name },
  );
}

/**
 * The objects whose DDL Go to Definition may open, most likely first, and the name
 * to put the cursor on. A table reference may well be a view, a call a procedure.
 */
export function definitionTargets(
  symbol: SqlSymbol,
): { readonly objects: readonly ObjectRef[]; readonly focus: string } | undefined {
  switch (symbol.kind) {
    case 'table':
      return {
        objects: [
          { ...symbol.table, kind: 'table' },
          { ...symbol.table, kind: 'view' },
        ],
        focus: symbol.table.name,
      };
    case 'column':
      return {
        objects: [
          { ...symbol.table, kind: 'table' },
          { ...symbol.table, kind: 'view' },
        ],
        focus: symbol.column,
      };
    case 'routine':
      return {
        objects: [
          { ...symbol.scope, kind: 'function', name: symbol.name },
          { ...symbol.scope, kind: 'procedure', name: symbol.name },
        ],
        focus: symbol.name,
      };
    case 'loose-column':
    case 'cte':
      return undefined;
  }
}
