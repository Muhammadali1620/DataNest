// Why a result cannot be edited in place; shared so the host can name the reason and
// the page can explain it in the user's language.

export const READ_ONLY_REASONS = [
  'not-select',
  'no-table',
  'distinct',
  'grouped',
  'compound',
  'multiple-tables',
  'subquery',
  'complex',
  'view',
  'table-not-found',
  'no-key',
  'key-not-selected',
  'columns-mismatch',
  'failed',
  /** The connection is marked read-only (V4.6). */
  'connection-read-only',
] as const;

export type ReadOnlyReason = (typeof READ_ONLY_REASONS)[number];
