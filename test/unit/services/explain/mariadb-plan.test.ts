import { describe, expect, it } from 'vitest';
import { readMariadbPlan } from '../../../../src/services/explain/mariadb-plan';
import { fixtureText } from '../../../helpers/fixtures';
import { outline } from '../../../helpers/plan-outline';

describe('readMariadbPlan', () => {
  it('nests blocks and lists the tables of a nested loop in join order', () => {
    const plan = readMariadbPlan(fixtureText('explain', 'mariadb-plan.json'), false);
    expect(outline(plan)).toEqual([
      'Query block #1',
      '  Sort !sort',
      '    Temporary table !temporary',
      '      Nested loop',
      '        Full index scan [i using fk_items_product] !full-scan',
      '        Unique index lookup [o using PRIMARY]',
      '        Unique index lookup [c using PRIMARY]',
    ]);
    const loop = plan.root.children[0]?.children[0]?.children[0];
    expect(loop?.children[1]?.detail).toBe('ref: datanest_test.i.order_id');
    expect(loop?.children[2]?.detail).toBe("c.country <> 'XX'");
    // A block costs what is under it; the query block holds the total.
    expect(loop?.cost).toBeCloseTo(0.021833275);
    expect(plan.root.cost).toBeCloseTo(0.021833275);
  });

  it('adds the real rows, loops and times of ANALYZE FORMAT=JSON', () => {
    const plan = readMariadbPlan(fixtureText('explain', 'mariadb-analyze.json'), true);
    expect(plan.properties).toEqual([['Planning time', '0.104297851 ms']]);
    expect(plan.root.timeMs).toBeCloseTo(5.449);
    const sort = plan.root.children[0];
    // The sort's own time plus the time of what feeds it.
    expect(sort?.timeMs).toBeCloseTo(0.9526 + 1.1059 + 0.7469 + 2.3685, 3);
    const first = sort?.children[0]?.children[0]?.children[0];
    expect(first).toMatchObject({ actualRows: 12, loops: 1, rows: 7 });
    expect(first?.timeMs).toBeCloseTo(1.1059, 3);
  });

  it('turns subqueries, unions and materialized tables into nodes', () => {
    const raw = JSON.stringify({
      query_block: {
        select_id: 1,
        table: {
          table_name: 't',
          access_type: 'ALL',
          rows: 1000,
          materialized: {
            query_block: {
              select_id: 2,
              table: { table_name: 'u', access_type: 'range', key: 'ix' },
            },
          },
        },
        subqueries: [
          { query_block: { select_id: 3, table: { table_name: 'v', access_type: 'const' } } },
        ],
      },
    });
    expect(outline(readMariadbPlan(raw, false))).toEqual([
      'Query block #1',
      '  Full table scan [t] !full-scan',
      '    Materialize',
      '      Query block #2',
      '        Index range scan [u using ix]',
      '  Subqueries',
      '    Query block #3',
      '      Constant row [v]',
    ]);
  });

  it('refuses answers that are not a plan', () => {
    expect(() => readMariadbPlan('{', false)).toThrow('not JSON');
    expect(() => readMariadbPlan('{"x":1}', false)).toThrow('without a query block');
  });
});
