import { describe, expect, it } from 'vitest';
import {
  isMisestimate,
  metricBasis,
  planMetrics,
  type PlanNode,
  planNodes,
  planRows,
  type QueryPlan,
} from '../../../src/shared/query-plan';

const node = (operation: string, extra: Partial<PlanNode> = {}): PlanNode => ({
  operation,
  warnings: [],
  properties: [],
  children: [],
  ...extra,
});

const plan = (root: PlanNode, analyzed = false): QueryPlan => ({
  root,
  analyzed,
  properties: [],
  notes: [],
  raw: '',
});

describe('planMetrics', () => {
  it('takes a node own cost as its cost minus its children', () => {
    const tree = plan(
      node('Sort', {
        cost: 100,
        children: [
          node('Hash Join', {
            cost: 90,
            children: [node('Seq Scan a', { cost: 60 }), node('Seq Scan b', { cost: 20 })],
          }),
        ],
      }),
    );
    const metrics = planMetrics(tree);
    expect(metrics.map((metric) => metric.self)).toEqual([10, 10, 60, 20]);
    expect(metrics.map((metric) => metric.heat)).toEqual(['mild', 'mild', 'hot', 'warm']);
    expect(metrics[2]?.share).toBeCloseTo(0.6);
  });

  it('uses real time once the statement ran, cost otherwise', () => {
    const root = node('Sort', {
      cost: 100,
      timeMs: 10,
      children: [node('Scan', { cost: 10, timeMs: 9 })],
    });
    expect(metricBasis(plan(root, true))).toBe('time');
    expect(planMetrics(plan(root, true)).map((metric) => metric.self)).toEqual([1, 9]);
    expect(metricBasis(plan(root, false))).toBe('cost');
    expect(planMetrics(plan(root, false)).map((metric) => metric.self)).toEqual([90, 10]);
  });

  it('falls back to cost when every time is zero', () => {
    const root = node('Sort', {
      cost: 4,
      timeMs: 0,
      children: [node('Scan', { cost: 3, timeMs: 0 })],
    });
    expect(metricBasis(plan(root, true))).toBe('cost');
  });

  it('counts a node without a value as the sum of its children', () => {
    const root = node('Sort', {
      children: [node('Join', { cost: 10, children: [node('Scan', { cost: 4 })] })],
    });
    expect(planMetrics(plan(root)).map((metric) => metric.self)).toEqual([0, 6, 4]);
  });

  it('never goes below zero when children report more than their parent', () => {
    const root = node('Reader', { timeMs: 1, children: [node('Scan', { timeMs: 5 })] });
    const metrics = planMetrics(plan(root, true));
    expect(metrics[0]?.self).toBe(0);
    expect(metrics.every((metric) => metric.share <= 1)).toBe(true);
  });

  it('gives no shares where the database gives no costs', () => {
    const root = node('Scan', { children: [node('Search')] });
    expect(metricBasis(plan(root))).toBe('none');
    expect(planMetrics(plan(root)).every((metric) => metric.heat === 'none')).toBe(true);
  });
});

describe('isMisestimate', () => {
  it('needs a tenfold difference of at least a hundred rows', () => {
    expect(isMisestimate(1000, 10)).toBe(true);
    expect(isMisestimate(10, 1000)).toBe(true);
    expect(isMisestimate(50, 5)).toBe(false);
    expect(isMisestimate(1000, 200)).toBe(false);
    expect(isMisestimate(0, 150)).toBe(true);
    expect(isMisestimate(undefined, 1000)).toBe(false);
  });
});

describe('planRows', () => {
  it('lists nodes in tree order with depth and how many rows they hold', () => {
    const root = node('A', {
      cost: 10,
      children: [
        node('B', { cost: 6, children: [node('C', { cost: 6 })] }),
        node('D', { cost: 2 }),
      ],
    });
    const rows = planRows(plan(root));
    expect(rows.map((row) => [row.operation, row.depth, row.descendants])).toEqual([
      ['A', 0, 3],
      ['B', 1, 1],
      ['C', 2, 0],
      ['D', 1, 0],
    ]);
    expect(rows[2]?.heat).toBe('hot');
    expect(planNodes(plan(root)).map((one) => one.operation)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('copies only the fields a node has', () => {
    const [row] = planRows(plan(node('Scan', { object: 't', warnings: ['full-scan'] })));
    expect(row).toEqual({
      depth: 0,
      operation: 'Scan',
      object: 't',
      warnings: ['full-scan'],
      properties: [],
      self: 0,
      share: 0,
      heat: 'none',
      descendants: 0,
    });
  });
});
