import { describe, expect, it } from 'vitest';
import { readPostgresPlan } from '../../../../src/services/explain/postgres-plan';
import { fixtureText } from '../../../helpers/fixtures';
import { outline } from '../../../helpers/plan-outline';

describe('readPostgresPlan', () => {
  it('turns the JSON plan into a tree with costs and rows', () => {
    const plan = readPostgresPlan(fixtureText('explain', 'postgres-plan.json'), false);
    expect(outline(plan)).toEqual([
      'Sort !sort',
      '  Aggregate',
      '    Hash Join',
      '      Hash Join',
      '        Seq Scan [order_items i] !full-scan',
      '        Hash',
      '          Seq Scan [orders o] !full-scan',
      '      Hash',
      '        Seq Scan [customers c] !full-scan',
    ]);
    expect(plan.root).toMatchObject({ cost: 87, rows: 69, detail: 'Sort Key: (count(*)) DESC' });
    expect(plan.root.children[0]?.children[0]?.detail).toBe('Hash Cond: (o.customer_id = c.id)');
    expect(plan.analyzed).toBe(false);
    expect(plan.root.properties).toContainEqual(['Plan Width', '524']);
  });

  it('adds real rows, loops, time and the plan totals after ANALYZE', () => {
    const plan = readPostgresPlan(fixtureText('explain', 'postgres-analyze.json'), true);
    expect(plan.analyzed).toBe(true);
    expect(plan.root).toMatchObject({ actualRows: 4, loops: 1, timeMs: 0.476 });
    expect(plan.properties).toEqual([
      ['Planning Time', '0.096 ms'],
      ['Execution Time', '0.527 ms'],
    ]);
    // 1450 expected, 12 found: the planner was far off.
    const scan = plan.root.children[0]?.children[0]?.children[0]?.children[0];
    expect(scan?.warnings).toEqual(['full-scan', 'misestimate']);
  });

  it('multiplies the time per loop by the loops and names outer joins as PostgreSQL does', () => {
    const raw = JSON.stringify([
      {
        Plan: {
          'Node Type': 'Nested Loop',
          'Join Type': 'Left',
          'Total Cost': 10,
          'Actual Total Time': 2,
          'Actual Loops': 1,
          Plans: [
            { 'Node Type': 'Seq Scan', 'Relation Name': 't', Alias: 't', 'Total Cost': 1 },
            {
              'Node Type': 'Index Scan',
              'Relation Name': 'u',
              Schema: 's',
              Alias: 'x',
              'Index Name': 'u_pk',
              'Index Cond': '(id = t.u_id)',
              'Actual Total Time': 0.01,
              'Actual Loops': 100,
            },
          ],
        },
      },
    ]);
    const plan = readPostgresPlan(raw, true);
    expect(plan.root.operation).toBe('Nested Loop Left Join');
    expect(plan.root.warnings).toEqual([]);
    const inner = plan.root.children[1];
    expect(inner).toMatchObject({
      object: 's.u x using u_pk',
      detail: 'Index Cond: (id = t.u_id)',
    });
    expect(inner?.timeMs).toBeCloseTo(1);
    expect(plan.root.children[0]?.object).toBe('t');
  });

  it('flags a nested loop without any condition, sorts that spill and hash joins named plainly', () => {
    const raw = JSON.stringify({
      Plan: {
        'Node Type': 'Nested Loop',
        'Join Type': 'Inner',
        Plans: [
          { 'Node Type': 'Seq Scan', 'Relation Name': 'a' },
          {
            'Node Type': 'Sort',
            'Sort Space Type': 'Disk',
            Plans: [{ 'Node Type': 'Seq Scan', 'Relation Name': 'b' }],
          },
        ],
      },
    });
    const plan = readPostgresPlan(raw, false);
    expect(plan.root.warnings).toEqual(['no-join-predicate']);
    expect(plan.root.children[1]?.warnings).toEqual(['sort', 'spill']);
  });

  it('refuses answers that are not a plan', () => {
    expect(() => readPostgresPlan('not json', false)).toThrow('not JSON');
    expect(() => readPostgresPlan('[{}]', false)).toThrow('without a Plan');
  });
});
