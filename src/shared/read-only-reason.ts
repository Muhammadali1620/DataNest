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
  /** Nodes and relationships are changed with Cypher, not row by row (V13.21). */
  'graph',
  /** An UPDATE in Cassandra writes even where no row exists, so rows are changed with CQL (V13.22). */
  'wide-column',
  /** The connection is marked read-only (V4.6). */
  'connection-read-only',
] as const;

export type ReadOnlyReason = (typeof READ_ONLY_REASONS)[number];
