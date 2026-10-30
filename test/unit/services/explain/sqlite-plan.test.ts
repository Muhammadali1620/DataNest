import { describe, expect, it } from 'vitest';
import { readSqlitePlan } from '../../../../src/services/explain/sqlite-plan';
import { outline } from '../../../helpers/plan-outline';

describe('readSqlitePlan', () => {
  it('hangs rows from their parents and spots scans without an index', () => {
    const plan = readSqlitePlan(
      [
        [2, 0, 0, 'SCAN c'],
        [5, 0, 0, 'SEARCH o USING INDEX ix_orders_customer (customer_id=?)'],
        [9, 0, 0, 'SCAN i USING COVERING INDEX sqlite_autoindex_order_items_1'],
        [20, 0, 0, 'USE TEMP B-TREE FOR GROUP BY'],
        [40, 0, 0, 'USE TEMP B-TREE FOR ORDER BY'],
        [44, 0, 0, 'CORRELATED SCALAR SUBQUERY 1'],
        [47, 44, 0, 'SEARCH p USING INTEGER PRIMARY KEY (rowid=?)'],
      ],
      'raw',
    );
    expect(outline(plan)).toEqual([
      'Query',
      '  Scan [c] !full-scan',
      '  Search [o]',
      '  Scan [i]',
      '  USE TEMP B-TREE FOR GROUP BY !temporary',
      '  USE TEMP B-TREE FOR ORDER BY !sort',
      '  CORRELATED SCALAR SUBQUERY 1',
      '    Search [p]',
    ]);
    expect(plan.root.children[1]?.detail).toBe('using INDEX ix_orders_customer (customer_id=?)');
    expect(plan.analyzed).toBe(false);
  });

  it('keeps rows whose parent is missing at the top', () => {
    const plan = readSqlitePlan([[3, 99, 0, 'SCAN t']], '');
    expect(outline(plan)).toEqual(['Query', '  Scan [t] !full-scan']);
  });

  it('gives an empty plan for no rows', () => {
    expect(readSqlitePlan([], '').root.children).toEqual([]);
  });
});
