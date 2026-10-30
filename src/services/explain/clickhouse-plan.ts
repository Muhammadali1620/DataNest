// ClickHouse plans (V8.2): `EXPLAIN json = 1, indexes = 1, description = 1` gives the
// query plan as steps; reading a MergeTree table lists how its indexes cut the parts
// and granules. ClickHouse has no costs and no EXPLAIN ANALYZE.

import { DbError } from '../../core/errors';
import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { numberOf, planNode, propertyText } from './plan-node';

const SHOWN = new Set(['Node Type', 'Plans', 'Description', 'Expression', 'Node Id']);

export function readClickhousePlan(raw: string): QueryPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DbError('internal', 'The server sent a plan that is not JSON', { cause: error });
  }
  const top: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(top) || !isRecord(top.Plan)) {
    throw new DbError('internal', 'The server sent a plan without a Plan');
  }
  return { root: node(top.Plan), analyzed: false, properties: [], notes: [], raw };
}

function node(step: Record<string, unknown>): PlanNode {
  const type = typeof step['Node Type'] === 'string' ? step['Node Type'] : 'Step';
  const description = typeof step.Description === 'string' ? step.Description : undefined;
  const reads = type.startsWith('ReadFrom');
  const indexes = Array.isArray(step.Indexes) ? step.Indexes.filter(isRecord) : [];
  const warnings: PlanWarning[] = [];
  // A MergeTree read whose indexes skip nothing reads every granule of the table; for a
  // table of one granule that is nothing to worry about.
  if (
    type === 'ReadFromMergeTree' &&
    (numberOf(step.Granules) ?? 2) > 1 &&
    indexes.every((index) => {
      const initial = numberOf(index['Initial Granules']);
      const selected = numberOf(index['Selected Granules']);
      return index.Condition === 'true' || (initial !== undefined && initial === selected);
    })
  ) {
    warnings.push('full-scan');
  }
  if (type === 'Sorting') {
    warnings.push('sort');
  }
  const properties: [string, string][] = Object.entries(step)
    .filter(([key]) => !SHOWN.has(key) && key !== 'Indexes')
    .map(([key, value]) => [key, propertyText(value)]);
  for (const index of indexes) {
    const type = typeof index.Type === 'string' ? index.Type : 'Index';
    const name = typeof index.Name === 'string' ? ` ${index.Name}` : '';
    properties.push([
      `${type}${name}`,
      `${propertyText(index.Condition ?? '')}; granules ${propertyText(index['Selected Granules'] ?? '?')} of ${propertyText(index['Initial Granules'] ?? '?')}`,
    ]);
  }
  const detailValue = step.Clauses ?? step.Keys ?? step['Sort Description'] ?? step.Type;
  return planNode({
    operation: type,
    object: reads ? description : undefined,
    detail: reads
      ? undefined
      : (description ?? (detailValue === undefined ? undefined : propertyText(detailValue))),
    warnings,
    properties,
    children: Array.isArray(step.Plans) ? step.Plans.filter(isRecord).map(node) : [],
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
