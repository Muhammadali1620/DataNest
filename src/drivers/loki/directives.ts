// The settings of a LogQL statement ride in `#` comments above it (V13.25), where LogQL itself
// ignores them:
//
//   # range: 6h          how far back from now (15m, 1h, 7d)
//   # start: 2026-11-01T00:00:00Z   and   # end: now-1h     a window of one's own
//   # step: 1m           the resolution of a metric query
//   # direction: forward  oldest first (the default is newest first)
//   # limit: 500         lines to read (the grid's row limit wins when it is smaller)
//
//   # tail: 30s         follow the query live for this long: new lines arrive as they are logged
//   # tail: forever     follow it with no time limit: until the row limit, Cancel or the server
//
// A statement that holds only such comments does not run: it sets the session's defaults.

import { DbError } from '../../core/errors';
import { syntaxOf, textOf, tokenize } from '../../core/sql/tokenizer';
import { msg } from '../../core/user-message';
import { parseDuration } from './time';

export interface Directives {
  readonly range?: string;
  readonly start?: string;
  readonly end?: string;
  readonly step?: string;
  readonly direction?: 'forward' | 'backward';
  readonly limit?: number;
  /** How long a live view lasts: `30s`, `5m`, or `forever` for no time limit (D162). */
  readonly tail?: string;
}

export interface ParsedStatement {
  readonly directives: Directives;
  /** True when something besides comments and blanks is in the text. */
  readonly hasQuery: boolean;
}

const KEYS = ['range', 'start', 'end', 'step', 'direction', 'limit', 'tail'] as const;
const SYNTAX = syntaxOf('loki');

/** The longest a timed live view may last: ten minutes. */
export const MAX_TAIL_MS = 600_000;

/** The words that ask for a live view without a time limit. */
export const TAIL_FOREVER = ['forever', 'on'] as const;

/** True when the `# tail:` value asks for a live view that has no time limit. */
export function isEndlessTail(value: string | undefined): boolean {
  return value !== undefined && (TAIL_FOREVER as readonly string[]).includes(value.toLowerCase());
}

export function parseStatement(sql: string): ParsedStatement {
  const found: Record<string, string> = {};
  let hasQuery = false;
  for (const token of tokenize(sql, SYNTAX)) {
    if (token.kind === 'whitespace') {
      continue;
    }
    if (token.kind !== 'comment') {
      hasQuery = true;
      continue;
    }
    const text = textOf(sql, token);
    if (!text.startsWith('#')) {
      continue;
    }
    // `# range: 1h` and `# start: … # end: …` on one line are both fine.
    for (const part of text.slice(1).split(/\s#\s/u)) {
      const match = /^\s*([a-z]+)\s*:\s*(.*?)\s*$/iu.exec(part);
      const key = match?.[1]?.toLowerCase();
      if (match !== null && key !== undefined && (KEYS as readonly string[]).includes(key)) {
        found[key] = match[2] ?? '';
      }
    }
  }
  return { directives: validated(found), hasQuery };
}

function validated(found: Readonly<Record<string, string>>): Directives {
  const result: { -readonly [K in keyof Directives]: Directives[K] } = {};
  if (found.range !== undefined) {
    if (parseDuration(found.range) === undefined) {
      throw new DbError(
        'syntax',
        msg('"{0}" is not a range of time: write it like 15m, 1h or 7d', found.range),
      );
    }
    result.range = found.range;
  }
  if (found.start !== undefined) {
    result.start = found.start;
  }
  if (found.end !== undefined) {
    result.end = found.end;
  }
  if (found.step !== undefined) {
    if (parseDuration(found.step) === undefined) {
      throw new DbError('syntax', msg('"{0}" is not a step: write it like 30s or 5m', found.step));
    }
    result.step = found.step;
  }
  if (found.direction !== undefined) {
    const direction = found.direction.toLowerCase();
    if (direction !== 'forward' && direction !== 'backward') {
      throw new DbError('syntax', msg('The direction is forward or backward'));
    }
    result.direction = direction;
  }
  if (found.tail !== undefined) {
    if (isEndlessTail(found.tail)) {
      result.tail = 'forever';
    } else {
      const ms = parseDuration(found.tail);
      if (ms === undefined || ms > MAX_TAIL_MS) {
        throw new DbError(
          'syntax',
          msg(
            '"{0}" is not a time to follow for: write it like 30s or 5m (at most 10m), or forever',
            found.tail,
          ),
        );
      }
      result.tail = found.tail;
    }
  }
  if (found.limit !== undefined) {
    const limit = Number(found.limit);
    if (!Number.isInteger(limit) || limit < 1) {
      throw new DbError('syntax', msg('The limit is a whole number above zero'));
    }
    result.limit = limit;
  }
  return result;
}
