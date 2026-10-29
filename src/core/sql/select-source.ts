// Reads a SELECT just far enough to say which single table its rows come from and
// which result column is which table column. Anything cleverer than
// `SELECT <columns> FROM <table> [WHERE …] [ORDER BY …] [LIMIT …]` is refused, so an
// edit is never aimed at rows the statement did not plainly read from one table.

import { unquoteIdentifier } from './identifiers';
import { isTrivia, textOf, tokenize, type SqlSyntax, type Token } from './tokenizer';

/** One entry of the select list. */
export type SelectItem =
  /** `*` or `alias.*`: every column of the table, in table order. */
  | { readonly kind: 'star' }
  /** A bare (possibly qualified) column, with the name it has in the result. */
  | { readonly kind: 'column'; readonly name: string; readonly output: string }
  /** Anything computed: a function, an operator, a literal. Never editable. */
  | { readonly kind: 'expression' };

/** The single table of a SELECT, as written (unquoted, case kept). */
export interface SelectSource {
  /** `[db.][schema.]table` parts, outermost first. */
  readonly tableParts: readonly string[];
  readonly alias?: string;
  readonly items: readonly SelectItem[];
}

/** Why a statement is not a plain read of one table. */
export type SelectRefusal =
  | 'not-select'
  | 'no-table'
  | 'distinct'
  | 'grouped'
  | 'compound'
  | 'multiple-tables'
  | 'subquery'
  | 'complex';

export type SelectParse =
  | { readonly ok: true; readonly source: SelectSource }
  | { readonly ok: false; readonly refusal: SelectRefusal };

const JOIN_WORDS = new Set([
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'STRAIGHT_JOIN',
  'OUTER',
]);

/** Words that end the table reference and start the tail of the statement. */
const TAIL_WORDS = new Set([
  'WHERE',
  'ORDER',
  'LIMIT',
  'OFFSET',
  'FETCH',
  'FOR',
  'LOCK',
  'GROUP',
  'HAVING',
  'WINDOW',
  'UNION',
  'INTERSECT',
  'EXCEPT',
  'MINUS',
]);

const GROUPING_WORDS = new Set(['GROUP', 'HAVING', 'WINDOW']);
const COMPOUND_WORDS = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);

interface Piece {
  readonly kind: Token['kind'];
  readonly text: string;
}

export function parseSelectSource(sql: string, syntax: SqlSyntax): SelectParse {
  const pieces = tokenize(sql, syntax)
    .filter((token) => !isTrivia(token))
    .map((token): Piece => ({ kind: token.kind, text: textOf(sql, token) }));
  while (pieces.at(-1)?.text === ';') {
    pieces.pop();
  }
  if (pieces.some((piece, index) => piece.text === ';' && index < pieces.length - 1)) {
    return refuse('complex');
  }
  if (upper(pieces[0]) !== 'SELECT' || pieces[0]?.kind !== 'word') {
    return refuse('not-select');
  }

  // Select list: everything up to the first top-level FROM.
  let index = 1;
  let depth = 0;
  const listStart = index;
  for (; index < pieces.length; index++) {
    const piece = pieces[index];
    if (piece === undefined) {
      break;
    }
    if (piece.text === '(') {
      depth++;
    } else if (piece.text === ')') {
      depth--;
    } else if (depth === 0 && piece.kind === 'word' && upper(piece) === 'FROM') {
      break;
    }
  }
  if (index >= pieces.length) {
    return refuse('no-table');
  }
  const list = pieces.slice(listStart, index);
  const first = upper(list[0]);
  if (first === 'DISTINCT' || first === 'DISTINCTROW' || first === 'UNIQUE') {
    return refuse('distinct');
  }
  const items = parseItems(withoutTop(first === 'ALL' ? list.slice(1) : list));

  index++; // FROM
  if (upper(pieces[index]) === 'ONLY') {
    index++; // PostgreSQL: do not descend into inheritance children.
  }
  if (pieces[index]?.text === '(') {
    return refuse('subquery');
  }
  const tableParts: string[] = [];
  for (;;) {
    const part = pieces[index];
    if (part === undefined || !isName(part)) {
      return refuse('complex');
    }
    tableParts.push(nameOf(part));
    index++;
    if (pieces[index]?.text === '.') {
      index++;
      continue;
    }
    break;
  }
  if (tableParts.length > 3) {
    return refuse('complex');
  }

  let alias: string | undefined;
  if (upper(pieces[index]) === 'AS') {
    index++;
    const name = pieces[index];
    if (name === undefined || !isName(name)) {
      return refuse('complex');
    }
    alias = nameOf(name);
    index++;
  } else {
    const next = pieces[index];
    if (next !== undefined && isName(next) && !isReserved(next)) {
      alias = nameOf(next);
      index++;
    }
  }

  // What follows the table decides whether it is still a plain read.
  const next = pieces[index];
  if (next !== undefined) {
    if (next.text === ',' || (next.kind === 'word' && JOIN_WORDS.has(upper(next)))) {
      return refuse('multiple-tables');
    }
    if (next.text === '(') {
      return refuse('complex');
    }
    if (!(next.kind === 'word' && TAIL_WORDS.has(upper(next)))) {
      return refuse('complex');
    }
  }
  depth = 0;
  for (const piece of pieces.slice(index)) {
    if (piece.text === '(') {
      depth++;
    } else if (piece.text === ')') {
      depth--;
    } else if (depth === 0 && piece.kind === 'word') {
      const word = upper(piece);
      if (GROUPING_WORDS.has(word)) {
        return refuse('grouped');
      }
      if (COMPOUND_WORDS.has(word)) {
        return refuse('compound');
      }
    }
  }
  return { ok: true, source: { tableParts, ...(alias === undefined ? {} : { alias }), items } };
}

function refuse(refusal: SelectRefusal): SelectParse {
  return { ok: false, refusal };
}

function parseItems(list: readonly Piece[]): SelectItem[] {
  const groups: Piece[][] = [[]];
  let depth = 0;
  for (const piece of list) {
    if (piece.text === '(') {
      depth++;
    } else if (piece.text === ')') {
      depth--;
    }
    if (depth === 0 && piece.text === ',') {
      groups.push([]);
    } else {
      groups.at(-1)?.push(piece);
    }
  }
  return groups.map(parseItem);
}

function parseItem(item: readonly Piece[]): SelectItem {
  if (item.length === 1 && item[0]?.text === '*') {
    return { kind: 'star' };
  }
  // A dotted name: name(.name)* optionally ending in `.*`.
  let index = 0;
  const parts: string[] = [];
  while (index < item.length) {
    const piece = item[index];
    if (piece === undefined || !isName(piece)) {
      return { kind: 'expression' };
    }
    parts.push(nameOf(piece));
    index++;
    if (item[index]?.text === '.') {
      index++;
      if (item[index]?.text === '*') {
        return index === item.length - 1 ? { kind: 'star' } : { kind: 'expression' };
      }
      continue;
    }
    break;
  }
  const name = parts.at(-1);
  if (name === undefined) {
    return { kind: 'expression' };
  }
  if (index === item.length) {
    return { kind: 'column', name, output: name };
  }
  // `[AS] alias`, and nothing after it.
  if (upper(item[index]) === 'AS') {
    index++;
  }
  const aliasPiece = item[index];
  if (aliasPiece === undefined || index !== item.length - 1) {
    return { kind: 'expression' };
  }
  // MySQL also allows 'alias' as a string.
  if (isName(aliasPiece) || aliasPiece.kind === 'string') {
    const output = aliasPiece.kind === 'string' ? aliasPiece.text.slice(1, -1) : nameOf(aliasPiece);
    return { kind: 'column', name, output };
  }
  return { kind: 'expression' };
}

function upper(piece: Piece | undefined): string {
  return piece?.text.toUpperCase() ?? '';
}

function isName(piece: Piece): boolean {
  return piece.kind === 'word' || piece.kind === 'quoted-identifier';
}

function isReserved(piece: Piece): boolean {
  if (piece.kind !== 'word') {
    return false;
  }
  const word = upper(piece);
  return TAIL_WORDS.has(word) || JOIN_WORDS.has(word) || word === 'AS';
}

/** A name without its quotes; doubled quote characters become one. */
/**
 * `TOP (10)`, `TOP 10 PERCENT`, `TOP (5) WITH TIES` (SQL Server) only limit the rows;
 * what follows is the select list.
 */
function withoutTop(list: readonly Piece[]): readonly Piece[] {
  if (upper(list[0]) !== 'TOP') {
    return list;
  }
  let index = 1;
  if (list[index]?.text === '(') {
    let depth = 0;
    for (; index < list.length; index++) {
      const text = list[index]?.text;
      depth += text === '(' ? 1 : text === ')' ? -1 : 0;
      if (depth === 0) {
        break;
      }
    }
  }
  index++;
  if (upper(list[index]) === 'PERCENT') {
    index++;
  }
  if (upper(list[index]) === 'WITH' && upper(list[index + 1]) === 'TIES') {
    index += 2;
  }
  return list.slice(index);
}

function nameOf(piece: Piece): string {
  if (piece.kind !== 'quoted-identifier') {
    return piece.text;
  }
  return unquoteIdentifier(piece.text);
}
