// A million result rows in the extension host (D6): how much memory they take and how
// fast the grid's window, sorting and search are — and that a sort never holds the host.

import { beforeAll, describe, expect, it } from 'vitest';
import { ResultStore, type ResultSummary } from '../../src/services/result-store';
import type { CellValue } from '../../src/shared/cell-value';
import { record, round, settledHeap, timed, timedWithBlocking } from '../helpers/perf';
import { MILLION_ROWS } from './budgets';

const COUNT = 1_000_000;

/** Six columns of the kinds a real table has: id, name, amount, date, e-mail, flag. */
function makeRows(): CellValue[][] {
  const rows: CellValue[][] = [];
  for (let index = 0; index < COUNT; index++) {
    rows.push([
      index,
      `customer ${(index * 7919) % COUNT}`,
      {
        kind: 'decimal',
        text: `${(index * 31) % 100_000}.${String(index % 100).padStart(2, '0')}`,
      },
      {
        kind: 'datetime',
        text: `2024-${String(1 + (index % 12)).padStart(2, '0')}-${String(1 + (index % 28)).padStart(2, '0')} 10:00:00`,
      },
      index % 10 === 0 ? null : `user${index % 5000}@example.com`,
      index % 2 === 0,
    ]);
  }
  return rows;
}

const COLUMNS = ['id', 'name', 'amount', 'created_at', 'email', 'active'].map((name) => ({
  name,
}));

describe('a million rows in the host', () => {
  let store: ResultStore;
  let summary: ResultSummary;

  beforeAll(() => {
    const before = settledHeap();
    const rows = makeRows();
    const after = settledHeap();
    record({
      name: 'heap per row (6 columns)',
      value: round((after - before) / COUNT),
      unit: 'B',
      budget: MILLION_ROWS.heapBytesPerRow,
    });
    store = new ResultStore();
    summary = store.add({
      documentUri: 'untitled:perf.sql',
      statement: 'SELECT …',
      statementStart: 0,
      columns: COLUMNS,
      rows,
      truncated: false,
      durationMs: 0,
    });
  });

  it('serves a window from the middle at once', async () => {
    const { ms, value } = await timed(() => store.window(summary.id, COUNT / 2, 200));
    expect(value?.rows).toHaveLength(200);
    record({
      name: 'grid window of 200 rows',
      value: round(ms),
      unit: 'ms',
      budget: MILLION_ROWS.windowMs,
    });
  });

  const sorts = [
    { column: 0, name: 'sort by numbers', budget: MILLION_ROWS.sortNumbersMs },
    { column: 2, name: 'sort by decimals', budget: MILLION_ROWS.sortNumbersMs },
    { column: 3, name: 'sort by dates', budget: MILLION_ROWS.sortDatesMs },
    { column: 4, name: 'sort by repeated text with NULLs', budget: MILLION_ROWS.sortDatesMs },
    { column: 1, name: 'sort by distinct text', budget: MILLION_ROWS.sortDistinctTextMs },
  ];

  it.each(sorts)('$name without holding the host', async ({ column, name, budget }) => {
    const { ms, longestBlockMs, value } = await timedWithBlocking(() =>
      store.sort(summary.id, column, 'desc'),
    );
    expect(value?.sort).toEqual({ column, direction: 'desc' });
    record({ name, value: round(ms), unit: 'ms', budget });
    record({
      name: `${name}: longest block`,
      value: round(longestBlockMs),
      unit: 'ms',
      budget: MILLION_ROWS.longestBlockMs,
    });
  });

  it('searches every cell without holding the host', async () => {
    const { ms, longestBlockMs, value } = await timedWithBlocking(() =>
      store.search(summary.id, 'no such text'),
    );
    expect(value?.total).toBe(0);
    record({
      name: 'search a million rows',
      value: round(ms),
      unit: 'ms',
      budget: MILLION_ROWS.searchMs,
    });
    record({
      name: 'search a million rows: longest block',
      value: round(longestBlockMs),
      unit: 'ms',
      budget: MILLION_ROWS.longestBlockMs,
    });
  });
});
