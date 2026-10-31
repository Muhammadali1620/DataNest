// How the statement log of the Manager page reads: one line per statement as a console
// would print it, filtered by text, copied as plain text.

import type { ManagerLogEntry } from '../../../../src/shared/protocols/manager';

/** Statements that contain every word of the filter, case ignored; errors only on request. */
export function filterLog(
  entries: readonly ManagerLogEntry[],
  text: string,
  errorsOnly: boolean,
): ManagerLogEntry[] {
  const words = text
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== '');
  return entries.filter((entry) => {
    if (errorsOnly && entry.ok) {
      return false;
    }
    const haystack = `${entry.sql} ${entry.error ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `2026-10-31 14:05:09`, in the user's own time zone. */
export function logTime(at: number): string {
  const when = new Date(at);
  return (
    `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())} ` +
    `${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}`
  );
}

/** `12 ms`, `1.4 s`, `2 min 5 s`: the units are symbols, the same in every language. */
export function formatTook(ms: number): string {
  const value = Math.max(0, Math.round(ms));
  if (value < 1000) {
    return `${value} ms`;
  }
  if (value < 60_000) {
    return `${(Math.round(value / 100) / 10).toString()} s`;
  }
  const seconds = Math.round(value / 1000);
  return `${Math.floor(seconds / 60)} min ${seconds % 60} s`;
}

export interface LogOutcome {
  readonly key:
    'manager.log.rows' | 'manager.log.affected' | 'manager.log.done' | 'manager.log.failed';
  readonly args: (string | number)[];
}

/** What the line after the statement says: rows, rows changed, done, or failed. */
export function logOutcome(entry: ManagerLogEntry): LogOutcome {
  const took = formatTook(entry.durationMs);
  if (!entry.ok) {
    return { key: 'manager.log.failed', args: [took] };
  }
  if (entry.rows !== undefined) {
    return { key: 'manager.log.rows', args: [entry.rows, took] };
  }
  if (entry.affected !== undefined) {
    return { key: 'manager.log.affected', args: [entry.affected, took] };
  }
  return { key: 'manager.log.done', args: [took] };
}

/** The lines as plain text, for the clipboard: time, statement, result. */
export function logText(
  entries: readonly ManagerLogEntry[],
  describe: (entry: ManagerLogEntry) => string,
): string {
  return entries
    .map((entry) => {
      const flat = entry.sql.replace(/\s+/gu, ' ').trim();
      const error = entry.error === undefined ? '' : `\n${entry.error}`;
      return `${logTime(entry.at)} ${flat}\n${describe(entry)}${error}`;
    })
    .join('\n');
}
