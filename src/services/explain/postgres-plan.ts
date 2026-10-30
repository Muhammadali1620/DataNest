// PostgreSQL plans (V8.2): `EXPLAIN (FORMAT JSON)`, with ANALYZE and BUFFERS when the
// statement ran. YugabyteDB answers the same way.

import { DbError } from '../../core/errors';
import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { numberOf, planNode, propertyText } from './plan-node';
import { msg } from '../../core/user-message';

/** Fields that become the node itself rather than lines in its details. */
const SHOWN = new Set([
  'Node Type',
  'Plans',
  'Relation Name',
  'Schema',
  'Alias',
  'Index Name',
  'Startup Cost',
  'Total Cost',
  'Plan Rows',
  'Actual Rows',
  'Actual Loops',
  'Actual Total Time',
]);

/** One line under the operation, from the fields that say how it works. */
const DETAIL_FIELDS = [
  'Hash Cond',
  'Merge Cond',
  'Join Filter',
  'Index Cond',
  'Recheck Cond',
  'Filter',
  'Sort Key',
  'Group Key',
  'Function Name',
  'CTE Name',
  'Subplan Name',
] as const;

export function readPostgresPlan(raw: string, analyzed: boolean): QueryPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DbError('internal', msg('The server sent a plan that is not JSON'), { cause: error });
  }
  const top: unknown = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!isRecord(top) || !isRecord(top.Plan)) {
    throw new DbError('internal', msg('The server sent a plan without a Plan'));
  }
  const properties: [string, string][] = [];
  for (const [key, value] of Object.entries(top)) {
    if (key !== 'Plan' && key !== 'Triggers' && (typeof value !== 'object' || value === null)) {
      properties.push([
        key,
        key.endsWith('Time') ? `${propertyText(value)} ms` : propertyText(value),
      ]);
    }
  }
  return { root: node(top.Plan), analyzed, properties, notes: [], raw };
}

function node(plan: Record<string, unknown>): PlanNode {
  const type = typeof plan['Node Type'] === 'string' ? plan['Node Type'] : 'Plan';
  const relation = text(plan['Relation Name']);
  const schema = text(plan.Schema);
  const alias = text(plan.Alias);
  const index = text(plan['Index Name']);
  const table =
    relation === undefined
      ? undefined
      : `${schema === undefined ? '' : `${schema}.`}${relation}${alias !== undefined && alias !== relation ? ` ${alias}` : ''}`;
  const object = [table, index === undefined ? undefined : `using ${index}`]
    .filter((part) => part !== undefined)
    .join(' ');
  const detailField = DETAIL_FIELDS.find((field) => plan[field] !== undefined);
  const loops = numberOf(plan['Actual Loops']);
  const perLoop = numberOf(plan['Actual Total Time']);
  const warnings: PlanWarning[] = [];
  if (type === 'Seq Scan') {
    warnings.push('full-scan');
  }
  if (type === 'Sort' || type === 'Incremental Sort') {
    warnings.push('sort');
  }
  if (plan['Sort Space Type'] === 'Disk' || (numberOf(plan['Temp Written Blocks']) ?? 0) > 0) {
    warnings.push('spill');
  }
  if (type === 'Nested Loop' && plan['Join Filter'] === undefined && !hasInnerCondition(plan)) {
    warnings.push('no-join-predicate');
  }
  const children = Array.isArray(plan.Plans) ? plan.Plans.filter(isRecord).map(node) : [];
  return planNode({
    operation: joinName(type, text(plan['Join Type'])),
    object,
    detail:
      detailField === undefined ? undefined : `${detailField}: ${propertyText(plan[detailField])}`,
    cost: numberOf(plan['Total Cost']),
    rows: numberOf(plan['Plan Rows']),
    actualRows: numberOf(plan['Actual Rows']),
    loops,
    timeMs: perLoop === undefined ? undefined : perLoop * (loops ?? 1),
    warnings,
    properties: Object.entries(plan)
      .filter(([key]) => !SHOWN.has(key))
      .map(([key, value]) => [key, propertyText(value)] as const),
    children,
  });
}

/** As PostgreSQL prints it: `Hash Left Join`, `Nested Loop Anti Join`; inner joins plain. */
function joinName(type: string, join: string | undefined): string {
  if (join === undefined || join === 'Inner') {
    return type;
  }
  return type.endsWith(' Join') ? type.replace(/ Join$/u, ` ${join} Join`) : `${type} ${join} Join`;
}

/** A nested loop whose inner side looks rows up by a condition is not a cross join. */
function hasInnerCondition(plan: Record<string, unknown>): boolean {
  const inner = Array.isArray(plan.Plans) ? plan.Plans.filter(isRecord)[1] : undefined;
  if (inner === undefined) {
    return true;
  }
  const conditions = ['Index Cond', 'Filter', 'Hash Cond', 'Recheck Cond', 'Join Filter'];
  const search = (candidate: Record<string, unknown>): boolean =>
    conditions.some((field) => candidate[field] !== undefined) ||
    (Array.isArray(candidate.Plans) && candidate.Plans.filter(isRecord).some(search));
  return search(inner);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
