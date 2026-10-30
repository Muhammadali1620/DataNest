import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { PlanNode, QueryPlan } from '../../../../src/shared/query-plan';
import { QueryPlanModel } from '../../../../src/vscode/panels/query-plan-model';

const node = (operation: string, extra: Partial<PlanNode> = {}): PlanNode => ({
  operation,
  warnings: [],
  properties: [],
  children: [],
  ...extra,
});

const plan = (raw = '{"Plan":{}}', analyzed = false): QueryPlan => ({
  root: node('Sort', {
    cost: 10,
    children: [node('Seq Scan', { cost: 8, warnings: ['full-scan'] })],
  }),
  analyzed,
  properties: [['Planning Time', '0.1 ms']],
  notes: ['CREATE INDEX ON t (a)'],
  raw,
});

function model(explain = vi.fn(() => Promise.resolve({ plan: plan(), canAnalyze: true }))) {
  return {
    explain,
    instance: new QueryPlanModel(
      { connectionName: 'Local', cancelledText: 'Cancelled', explain },
      'SELECT * FROM t',
    ),
  };
}

describe('QueryPlanModel', () => {
  it('shows the statement and nothing else before the first run', () => {
    const { instance } = model();
    expect(instance.state()).toEqual({
      statement: 'SELECT * FROM t',
      connection: 'Local',
      canAnalyze: false,
      running: false,
      analyzed: false,
      basis: 'none',
      rows: [],
      properties: [],
      notes: [],
    });
    expect(instance.raw()).toBeUndefined();
  });

  it('runs the explain and keeps the plan as rows with shares', async () => {
    const { instance, explain } = model();
    const running = instance.run(false);
    expect(instance.isRunning).toBe(true);
    expect(instance.state().running).toBe(true);
    await running;
    expect(explain).toHaveBeenCalledWith('SELECT * FROM t', false);
    const state = instance.state();
    expect(state.running).toBe(false);
    expect(state.canAnalyze).toBe(true);
    expect(state.basis).toBe('cost');
    expect(state.rows.map((row) => [row.operation, row.depth, row.heat])).toEqual([
      ['Sort', 0, 'warm'],
      ['Seq Scan', 1, 'hot'],
    ]);
    expect(state.notes).toEqual(['CREATE INDEX ON t (a)']);
    expect(state.properties).toEqual([['Planning Time', '0.1 ms']]);
  });

  it('shows why there is no plan, and says "Cancelled" for a cancel', async () => {
    const failing = vi.fn(() => Promise.reject(new DbError('syntax', 'syntax error near "SELEC"')));
    const { instance } = model(failing);
    await instance.run(false);
    expect(instance.state().error).toBe('syntax error near "SELEC"');
    failing.mockRejectedValueOnce(new DbError('cancelled', 'Query was interrupted'));
    await instance.run(true);
    expect(instance.state().error).toBe('Cancelled');
  });

  it('forgets the old plan for a new statement, but not for the same one', async () => {
    const { instance, explain } = model();
    await instance.run(false);
    instance.setStatement('SELECT * FROM t');
    expect(instance.state().rows).toHaveLength(2);
    instance.setStatement('SELECT 2');
    expect(instance.state().rows).toEqual([]);
    await instance.run(true);
    expect(explain).toHaveBeenLastCalledWith('SELECT 2', true);
  });

  it('clears the last error on a new run', async () => {
    const explain = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({
      plan: plan(),
      canAnalyze: false,
    });
    const { instance } = model(explain);
    await instance.run(false);
    await instance.run(false);
    expect(instance.state().error).toBeUndefined();
  });

  it('gives the original answer with a language to show it in', async () => {
    for (const [raw, language] of [
      ['[{"Plan":{}}]', 'json'],
      ['  <ShowPlanXML/>', 'xml'],
      ['• scan', 'plaintext'],
    ] as const) {
      const { instance } = model(
        vi.fn(() => Promise.resolve({ plan: plan(raw), canAnalyze: false })),
      );
      await instance.run(false);
      expect(instance.raw()).toEqual({ text: raw, language });
    }
    const { instance } = model(vi.fn(() => Promise.resolve({ plan: plan(''), canAnalyze: false })));
    await instance.run(false);
    expect(instance.raw()).toBeUndefined();
  });
});
