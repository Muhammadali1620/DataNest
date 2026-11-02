// Opening a label from the tree builds two lines of SQL — the shape every table view, export
// and search uses — and Loki speaks LogQL. This turns exactly those shapes into a query and
// leaves everything else to the server:
//
//   SELECT * FROM `app` ORDER BY `time` DESC LIMIT 100 OFFSET 200
//   SELECT COUNT(*) FROM `app`
//
// A label is a "table": the lines of every stream that has it, newest first.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';

export interface TableQuery {
  readonly kind: 'rows' | 'count';
  /** The LogQL stream selector: every stream that has the label. */
  readonly selector: string;
  readonly direction: 'forward' | 'backward';
  /** Rows to read; absent for the count. */
  readonly limit?: number;
  readonly offset: number;
}

const HEAD = /^\s*SELECT\s+(\*|COUNT\s*\(\s*\*\s*\))\s+FROM\s+`((?:[^`]|``)*)`([\s\S]*)$/iu;
const TAIL =
  /^\s*(?:ORDER\s+BY\s+`(?:[^`]|``)*`\s*(ASC|DESC)?\s*)?(?:LIMIT\s+(\d+)\s*(?:OFFSET\s+(\d+))?)?\s*;?\s*$/iu;
const LABEL = /^[A-Za-z_][A-Za-z0-9_]*$/u;

export function translateTableQuery(sql: string): TableQuery | undefined {
  const head = HEAD.exec(sql);
  if (head === null) {
    return undefined;
  }
  const label = (head[2] ?? '').replaceAll('``', '`');
  const tail = head[3] ?? '';
  if (/\bWHERE\b/iu.test(tail)) {
    throw new DbError(
      'unsupported',
      msg('Filters are not available for Loki: write the selector and the line filters in LogQL'),
    );
  }
  const parts = TAIL.exec(tail);
  if (parts === null || !LABEL.test(label)) {
    return undefined;
  }
  const selector = `{${label}=~".+"}`;
  if ((head[1] ?? '').toUpperCase() !== '*') {
    return { kind: 'count', selector, direction: 'backward', offset: 0 };
  }
  return {
    kind: 'rows',
    selector,
    // Newest first, unless the grid sorted by time upwards.
    direction: (parts[1] ?? '').toUpperCase() === 'ASC' ? 'forward' : 'backward',
    ...(parts[2] === undefined ? {} : { limit: Number(parts[2]) }),
    offset: parts[3] === undefined ? 0 : Number(parts[3]),
  };
}
