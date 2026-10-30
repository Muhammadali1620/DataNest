// MariaDB plans (V8.2): `EXPLAIN FORMAT=JSON`, and `ANALYZE FORMAT=JSON` when the
// statement ran. Blocks nest (query block → sort → temporary table → nested loop →
// tables); a nested loop lists its tables in join order.

import { DbError } from '../../core/errors';
import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { numberOf, planNode, propertyText } from './plan-node';
import { msg } from '../../core/user-message';

const BLOCKS: Readonly<Record<string, string>> = {
  query_block: 'Query block',
  filesort: 'Sort',
  temporary_table: 'Temporary table',
  nested_loop: 'Nested loop',
  ordering_operation: 'Order',
  grouping_operation: 'Group',
  duplicates_removal: 'Remove duplicates',
  union_result: 'Union',
  materialized: 'Materialize',
  materialized_from_subquery: 'Materialize',
  subqueries: 'Subqueries',
  query_specifications: 'Union parts',
  read_sorted_file: 'Read sorted file',
  'block-nl-join': 'Block nested loop join',
  window_functions_computation: 'Window functions',
  having: 'Having',
};

const ACCESS: Readonly<Record<string, string>> = {
  ALL: 'Full table scan',
  index: 'Full index scan',
  range: 'Index range scan',
  ref: 'Index lookup',
  eq_ref: 'Unique index lookup',
  ref_or_null: 'Index lookup or NULL',
  const: 'Constant row',
  system: 'Constant row',
  index_merge: 'Index merge',
  fulltext: 'Full-text search',
  hash_ALL: 'Hash join, full scan',
  hash_index: 'Hash join, index',
  hash_range: 'Hash join, range',
};

export function readMariadbPlan(raw: string, analyzed: boolean): QueryPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new DbError('internal', msg('The server sent a plan that is not JSON'), { cause: error });
  }
  if (!isRecord(parsed) || !isRecord(parsed.query_block)) {
    throw new DbError('internal', msg('The server sent a plan without a query block'));
  }
  const properties: [string, string][] = [];
  const planning = isRecord(parsed.query_optimization)
    ? numberOf(parsed.query_optimization.r_total_time_ms)
    : undefined;
  if (planning !== undefined) {
    properties.push(['Planning time', `${planning} ms`]);
  }
  const [root] = walk('query_block', parsed.query_block);
  if (root === undefined) {
    throw new DbError('internal', msg('The server sent an empty plan'));
  }
  return { root, analyzed, properties, notes: [], raw };
}

function walk(key: string, value: unknown): PlanNode[] {
  if (key === 'table' && isRecord(value)) {
    return [table(value)];
  }
  const label = BLOCKS[key];
  if (Array.isArray(value)) {
    const children = value.filter(isRecord).flatMap(entriesOf);
    return label === undefined ? children : [block(label, {}, children)];
  }
  if (!isRecord(value)) {
    return [];
  }
  const children = entriesOf(value);
  return label === undefined ? children : [block(label, value, children)];
}

function entriesOf(record: Record<string, unknown>): PlanNode[] {
  return Object.entries(record)
    .filter(([, value]) => typeof value === 'object' && value !== null)
    .flatMap(([key, value]) => walk(key, value));
}

function block(label: string, record: Record<string, unknown>, children: PlanNode[]): PlanNode {
  const warnings: PlanWarning[] = [];
  if (label === 'Sort' || record.using_filesort === true) {
    warnings.push('sort');
  }
  if (label === 'Temporary table' || record.using_temporary_table === true) {
    warnings.push('temporary');
  }
  const childCost = sum(children.map((child) => child.cost));
  const own =
    numberOf(record.cost) ??
    numberOf(isRecord(record.cost_info) ? record.cost_info.query_cost : undefined);
  const childTime = sum(children.map((child) => child.timeMs));
  const id = numberOf(record.select_id);
  return planNode({
    operation: label === 'Query block' && id !== undefined ? `${label} #${id}` : label,
    detail: typeof record.sort_key === 'string' ? record.sort_key : undefined,
    // Blocks other than the query block have no cost of their own: theirs is what is under them.
    cost: own !== undefined && (childCost === undefined || own >= childCost) ? own : childCost,
    actualRows: numberOf(record.r_output_rows),
    loops: numberOf(record.r_loops),
    // A query block's time holds everything in it; a sort's is the sorting alone.
    timeMs:
      label === 'Query block'
        ? (numberOf(record.r_total_time_ms) ?? childTime)
        : sum([numberOf(record.r_total_time_ms), childTime]),
    warnings,
    properties: scalars(record),
    children,
  });
}

function table(record: Record<string, unknown>): PlanNode {
  const access = typeof record.access_type === 'string' ? record.access_type : '';
  const name = typeof record.table_name === 'string' ? record.table_name : '';
  const key = typeof record.key === 'string' ? record.key : undefined;
  const warnings: PlanWarning[] = [];
  if (access === 'ALL' || access === 'index' || access === 'hash_ALL') {
    warnings.push('full-scan');
  }
  const condition =
    typeof record.attached_condition === 'string'
      ? record.attached_condition
      : Array.isArray(record.ref)
        ? `ref: ${propertyText(record.ref)}`
        : undefined;
  const tableTime = numberOf(record.r_table_time_ms);
  const otherTime = numberOf(record.r_other_time_ms);
  return planNode({
    operation: ACCESS[access] ?? (access === '' ? 'Table' : access),
    object: key === undefined ? name : `${name} using ${key}`,
    detail: condition,
    cost:
      numberOf(record.cost) ??
      numberOf(isRecord(record.cost_info) ? record.cost_info.prefix_cost : undefined),
    rows: numberOf(record.rows) ?? numberOf(record.rows_examined_per_scan),
    actualRows: numberOf(record.r_rows),
    loops: numberOf(record.r_loops),
    timeMs:
      tableTime === undefined && otherTime === undefined
        ? undefined
        : (tableTime ?? 0) + (otherTime ?? 0),
    warnings,
    properties: scalars(record),
    // A table can hold a subquery that runs for each of its rows.
    children: entriesOf(record),
  });
}

function scalars(record: Record<string, unknown>): [string, string][] {
  return Object.entries(record)
    .filter(
      ([key, value]) =>
        (typeof value !== 'object' || value === null || Array.isArray(value)) &&
        !(
          Array.isArray(value) && value.some((item) => typeof item === 'object' && item !== null)
        ) &&
        !(key in BLOCKS),
    )
    .map(([key, value]) => [key, propertyText(value)]);
}

function sum(values: readonly (number | undefined)[]): number | undefined {
  const known = values.filter((value): value is number => value !== undefined);
  return known.length === 0 ? undefined : known.reduce((total, value) => total + value, 0);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
