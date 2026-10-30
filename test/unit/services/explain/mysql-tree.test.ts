import { describe, expect, it } from 'vitest';
import { readMysqlTree, splitText } from '../../../../src/services/explain/mysql-tree';
import { fixtureText } from '../../../helpers/fixtures';
import { outline } from '../../../helpers/plan-outline';

describe('readMysqlTree', () => {
  it('builds the tree from the indentation of EXPLAIN FORMAT=TREE', () => {
    const plan = readMysqlTree(fixtureText('explain', 'mysql-tree.txt'), false);
    expect(outline(plan)).toEqual([
      'Sort !sort',
      '  Table scan [<temporary>] !temporary',
      '    Aggregate using temporary table !temporary',
      '      Nested loop inner join',
      '        Nested loop inner join',
      '          Filter',
      '            Table scan [c] !full-scan',
      '          Covering index lookup [o using ix_orders_customer]',
      '        Covering index lookup [i using PRIMARY]',
    ]);
    const join = plan.root.children[0]?.children[0]?.children[0];
    expect(join).toMatchObject({ cost: 13.5, rows: 9.6 });
    expect(join?.children[0]?.children[0]?.detail).toBe("(c.country <> 'XX')");
  });

  it('reads the real time per loop, rows and loops of EXPLAIN ANALYZE', () => {
    const plan = readMysqlTree(fixtureText('explain', 'mysql-analyze.txt'), true);
    expect(plan.analyzed).toBe(true);
    expect(plan.root).toMatchObject({ actualRows: 4, loops: 1, timeMs: 3.39 });
    const lookup = plan.root.children[0]?.children[0]?.children[0]?.children[0]?.children[1];
    expect(lookup).toMatchObject({ actualRows: 1.75, loops: 4, cost: 1.04 });
    expect(lookup?.timeMs).toBeCloseTo(0.0781 * 4);
  });

  it('marks nodes that never ran and joins a wrapped line to its node', () => {
    const raw = [
      '-> Nested loop inner join  (cost=2 rows=1) (actual time=0.1..0.1 rows=0 loops=1)',
      '    -> Table scan on t  (cost=1 rows=1) (actual time=0.05..0.05 rows=0 loops=1)',
      '    -> Single-row index lookup on u using PRIMARY (id=t.u_id)  (cost=1 rows=1) (never executed)',
      '-> Select #2 (subquery in condition; run only once)',
      '    -> Filter: (x = 1',
      '        and y = 2)',
    ].join('\n');
    const plan = readMysqlTree(raw, true);
    expect(plan.root.operation).toBe('Query');
    const never = plan.root.children[0]?.children[1];
    expect(never).toMatchObject({ actualRows: 0, loops: 0, timeMs: 0 });
    expect(never?.properties).toContainEqual(['Executed', 'never']);
    expect(plan.root.children[1]?.children[0]?.detail).toBe('(x = 1 and y = 2)');
  });
});

describe('splitText', () => {
  it('splits operations with a colon, an object or a condition', () => {
    expect(splitText('Sort: n DESC')).toEqual({ operation: 'Sort', detail: 'n DESC' });
    expect(splitText('Table scan on c')).toEqual({ operation: 'Table scan', object: 'c' });
    expect(splitText('Index range scan on t using ix over (a < 3)')).toEqual({
      operation: 'Index range scan',
      object: 't using ix',
      detail: 'over (a < 3)',
    });
    expect(splitText('Nested loop inner join')).toEqual({ operation: 'Nested loop inner join' });
  });
});
