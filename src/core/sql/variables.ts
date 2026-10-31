// Variables in SQL text (V10.2.1): `:name` and `${name}` stand for values the user is
// asked for when the statement runs. Only code is searched — never strings, comments
// or quoted names — and never routine or trigger definitions, where `:new.id` is the
// server's own syntax. Values go in as literals of the dialect (D103).

import type { CellValue } from '../../shared/cell-value';
import type { DriverId } from '../../shared/connection';
import { isTrivia, syntaxOf, textOf, tokenize, type Token } from './tokenizer';

export interface SqlVariable {
  readonly name: string;
  /** Offset of the `:` or `$` in the statement. */
  readonly start: number;
  /** Offset just past the name (or the closing `}`). */
  readonly end: number;
}

/** The text a statement runs as, and how to find a place of it in the original. */
export interface Substitution {
  readonly text: string;
  /** An offset in `text` as an offset in the original statement. */
  toSource(position: number): number;
}

/** Words after `CREATE`/`ALTER` that make the statement a body the server compiles. */
const DEFINITIONS: ReadonlySet<string> = new Set([
  'TRIGGER',
  'PROCEDURE',
  'PROC',
  'FUNCTION',
  'PACKAGE',
  'TYPE',
  'EVENT',
]);

/** How many words of a `CREATE` may come before the kind (`OR REPLACE`, `DEFINER = …`). */
const DEFINITION_LOOKAHEAD = 8;

/**
 * Tokens a `:` may follow without being a variable: `a::int`, `arr[1:n]`, `@x:=1`,
 * `{id:UInt32}` and labels all have a name, number or bracket right before it.
 */
function attachedBefore(token: Token | undefined, sql: string): boolean {
  if (token === undefined || isTrivia(token)) {
    return false;
  }
  if (token.kind === 'punctuation') {
    return [':', ']', ')', '}'].includes(textOf(sql, token));
  }
  return true;
}

function isDefinition(sql: string, tokens: readonly Token[]): boolean {
  const words = tokens
    .filter((token) => token.kind === 'word')
    .slice(0, DEFINITION_LOOKAHEAD)
    .map((token) => textOf(sql, token).toUpperCase());
  const [first] = words;
  if (first !== 'CREATE' && first !== 'ALTER') {
    return false;
  }
  return words.slice(1).some((word) => DEFINITIONS.has(word));
}

/** The variables of one statement, in the order they appear. */
export function findVariables(sql: string, driver?: DriverId): SqlVariable[] {
  const tokens = tokenize(sql, syntaxOf(driver));
  if (isDefinition(sql, tokens)) {
    return [];
  }
  const found: SqlVariable[] = [];
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    if (token?.kind !== 'punctuation') {
      continue;
    }
    const mark = textOf(sql, token);
    const next = tokens[index + 1];
    if (mark === ':' && next?.kind === 'word' && !attachedBefore(tokens[index - 1], sql)) {
      found.push({ name: textOf(sql, next), start: token.start, end: next.end });
      index++;
      continue;
    }
    if (mark !== '$' || next === undefined || textOf(sql, next) !== '{') {
      continue;
    }
    const name = tokens[index + 2];
    const close = tokens[index + 3];
    if (name?.kind === 'word' && close !== undefined && textOf(sql, close) === '}') {
      found.push({ name: textOf(sql, name), start: token.start, end: close.end });
      index += 3;
    }
  }
  return found;
}

/** Each name once, in the order it first appears. */
export function variableNames(variables: readonly SqlVariable[]): string[] {
  return [...new Set(variables.map((variable) => variable.name))];
}

/**
 * Replaces each variable with its value's text. A position in the result maps back to
 * the original: inside a value it is the variable's start, after it shifted back.
 */
export function substituteVariables(
  sql: string,
  variables: readonly SqlVariable[],
  valueOf: (name: string) => string,
): Substitution {
  const ordered = [...variables].sort((a, b) => a.start - b.start);
  const parts: string[] = [];
  /** Where each value lands in the result, and the variable it replaced. */
  const placed: { from: number; to: number; source: SqlVariable }[] = [];
  let cursor = 0;
  let length = 0;
  for (const variable of ordered) {
    if (variable.start < cursor) {
      continue;
    }
    const before = sql.slice(cursor, variable.start);
    const value = valueOf(variable.name);
    parts.push(before, value);
    length += before.length;
    placed.push({ from: length, to: length + value.length, source: variable });
    length += value.length;
    cursor = variable.end;
  }
  parts.push(sql.slice(cursor));
  return {
    text: parts.join(''),
    toSource(position: number): number {
      let shift = 0;
      for (const { from, to, source } of placed) {
        if (position < from) {
          break;
        }
        if (position < to) {
          return source.start;
        }
        shift = source.end - to;
      }
      return Math.max(0, position + shift);
    },
  };
}

/** A number written the usual way: no leading zeros (`007` is a code, not seven). */
const PLAIN_NUMBER = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/u;

/**
 * What the user typed as the value of a variable: `NULL`, a number, or text. Text in
 * single quotes stays text even when it looks like a number (`'42'`), with `''` for
 * a quote inside.
 */
export function variableValue(input: string): CellValue {
  const trimmed = input.trim();
  if (/^null$/iu.test(trimmed)) {
    return null;
  }
  if (PLAIN_NUMBER.test(trimmed)) {
    return { kind: 'decimal', text: trimmed };
  }
  const quoted = /^'([\s\S]*)'$/u.exec(trimmed);
  if (quoted !== null) {
    return (quoted[1] ?? '').replaceAll("''", "'");
  }
  return input;
}
