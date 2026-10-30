import { describe, expect, it } from 'vitest';
import { readCockroachPlan } from '../../../../src/services/explain/cockroach-plan';
import { fixtureText } from '../../../helpers/fixtures';
import { outline } from '../../../helpers/plan-outline';

describe('readCockroachPlan', () => {
  it('reads the bullet tree, its properties and the index recommendations', () => {
    const plan = readCockroachPlan(fixtureText('explain', 'cockroach-plan.txt'), false);
    expect(outline(plan)).toEqual([
      'sort !sort',
      '  group (hash)',
      '    hash join',
      '      scan [order_items@order_items_pkey] !full-scan',
      '      merge join',
      '        scan [orders@ix_orders_customer] !full-scan',
      '        filter',
      '          scan [customers@customers_pkey] !full-scan',
    ]);
    expect(plan.properties).toEqual([
      ['distribution', 'local'],
      ['vectorized', 'true'],
    ]);
    expect(plan.notes).toEqual([
      'CREATE INDEX ON datanest_test.public.customers (country) STORING (full_name);',
    ]);
    const join = plan.root.children[0]?.children[0];
    expect(join).toMatchObject({ rows: 10, detail: 'equality: (order_id) = (id)' });
    expect(join?.properties).toContainEqual(['right cols are key', '']);
  });

  it('reads real rows and the statement totals after ANALYZE', () => {
    const plan = readCockroachPlan(fixtureText('explain', 'cockroach-analyze.txt'), true);
    expect(plan.root.actualRows).toBe(4);
    expect(plan.properties).toContainEqual(['execution time', '2ms']);
    expect(outline(plan)).toHaveLength(8);
  });

  it('reads a node time where the server gives one', () => {
    const plan = readCockroachPlan(
      ['• scan', '  execution time: 1.5ms', '  table: t@t_pkey', '  spans: [/1 - /9]'].join('\n'),
      true,
    );
    expect(plan.root).toMatchObject({ timeMs: 1.5, detail: 'spans: [/1 - /9]', warnings: [] });
  });
});
