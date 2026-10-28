// Where a failed statement's error goes in its document: on the word the server
// complained about when the position is known, else over the whole statement.
// Errors that are not about the text (a lost link, a cancel) get no marker.

import type { DbErrorCode } from '../core/errors';
import { isTrivia, syntaxOf, tokenize } from '../core/sql/tokenizer';
import type { DriverId } from '../shared/connection';
import type { ResultSummary } from './result-store';

export interface ErrorMarker {
  readonly start: number;
  readonly end: number;
  readonly message: string;
  /** The error category (`syntax`, `not-found`, …), shown as the diagnostic code. */
  readonly code: string;
}

/** Codes that say something about the connection or the run, not about the SQL. */
const NOT_ABOUT_TEXT: ReadonlySet<string> = new Set<DbErrorCode>([
  'cancelled',
  'timeout',
  'connection-failed',
  'auth-failed',
  'busy',
]);

export function errorMarkers(
  text: string,
  results: readonly Pick<ResultSummary, 'statement' | 'statementStart' | 'error'>[],
  driver: DriverId | undefined,
): ErrorMarker[] {
  const markers: ErrorMarker[] = [];
  for (const result of results) {
    const { error, statement, statementStart } = result;
    if (error === undefined || NOT_ABOUT_TEXT.has(error.code)) {
      continue;
    }
    // The document may have changed while the statement ran: then the offsets lie.
    if (text.slice(statementStart, statementStart + statement.length) !== statement) {
      continue;
    }
    const base = { message: error.message, code: error.code };
    const position = error.position;
    if (position === undefined || position < 0 || position > statement.length) {
      markers.push({ ...base, start: statementStart, end: statementStart + statement.length });
      continue;
    }
    // The token at the position, or the next one when the position falls on a space.
    const token = tokenize(statement, syntaxOf(driver)).find(
      (candidate) => !isTrivia(candidate) && candidate.end > position,
    );
    // Past the last word an empty range would be invisible: mark the last character.
    const start =
      token === undefined ? Math.max(0, statement.length - 1) : Math.max(token.start, position);
    const end = token === undefined ? statement.length : token.end;
    markers.push({ ...base, start: statementStart + start, end: statementStart + end });
  }
  return markers;
}
