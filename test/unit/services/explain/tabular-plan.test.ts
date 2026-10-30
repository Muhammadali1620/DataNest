import { describe, expect, it } from 'vitest';
import { readTabularPlan } from '../../../../src/services/explain/tabular-plan';
import type { CellValue } from '../../../../src/shared/cell-value';
import { fixtureJson } from '../../../helpers/fixtures';
import { outline } from '../../../helpers/plan-outline';

interface Table {
  columns: string[];
  rows: CellValue[][];
}

describe('readTabularPlan for TiDB', () => {
  it('reads the tree drawn into the id column', () => {
    const { columns, rows } = fixtureJson('explain', 'tidb-plan.json') as Table;
    const plan = readTabularPlan(columns, rows, false, 'raw');
    expect(outline(plan).slice(0, 6)).toEqual([
      'Sort !sort',
      '  Projection',
      '    HashAgg',
      '      HashJoin',
      '        IndexReader',
      '          IndexFullScan [table:i, index:fk_items_product(product_id)] !full-scan,missing-statistics',
    ]);
    expect(plan.raw).toBe('raw');
    expect(plan.root.rows).toBeCloseTo(5325.33);
    expect(plan.root.children[0]?.children[0]?.children[0]?.children[0]?.properties).toContainEqual(
      ['Side', 'Build'],
    );
  });

  it('reads real rows and the time from the execution info of EXPLAIN ANALYZE', () => {
    const { columns, rows } = fixtureJson('explain', 'tidb-analyze.json') as Table;
    const plan = readTabularPlan(columns, rows, true, '');
    expect(plan.root).toMatchObject({ actualRows: 4, timeMs: 1.25 });
    const join = plan.root.children[0]?.children[0]?.children[0];
    expect(join?.timeMs).toBeCloseTo(0.9126);
    expect(join?.properties.some(([key]) => key === 'execution info')).toBe(true);
  });
});

describe('readTabularPlan for the classic MySQL EXPLAIN', () => {
  it('lists the tables in join order with their access and extras', () => {
    const { columns, rows } = fixtureJson('explain', 'mysql-classic.json') as Table;
    const plan = readTabularPlan(columns, rows, false, '');
    expect(outline(plan)).toEqual([
      'Query',
      '  Full table scan [c] !full-scan,sort,temporary',
      '  Index lookup [o using ix_orders_customer]',
      '  Index lookup [i using PRIMARY]',
    ]);
    expect(plan.root.children[0]?.rows).toBe(5);
    expect(plan.root.children[1]?.properties).toContainEqual([
      'possible_keys',
      'PRIMARY,ix_orders_customer',
    ]);
  });
});
