// Oracle plans (V8.2): `EXPLAIN PLAN` writes rows into PLAN_TABLE, read back with
// their parent ids. Costs and cardinalities are the optimizer's estimates; Oracle's
// real figures need the cursor cache, which DataNest does not read.

import type { CellValue } from '../../shared/cell-value';
import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { cellNumber, cellText, planNode } from './plan-node';

/** The PLAN_TABLE columns DataNest reads, in this order. */
export const ORACLE_PLAN_COLUMNS = [
  'id',
  'parent_id',
  'operation',
  'options',
  'object_owner',
  'object_name',
  'object_alias',
  'object_type',
  'cost',
  'cardinality',
  'bytes',
  'cpu_cost',
  'io_cost',
  'time',
  'access_predicates',
  'filter_predicates',
  'optimizer',
  'qblock_name',
] as const;

export function readOraclePlan(
  columns: readonly string[],
  rows: readonly (readonly CellValue[])[],
  raw: string,
): QueryPlan {
  const at = (name: string): number => columns.findIndex((column) => column.toLowerCase() === name);
  const entries = rows.map((row) => ({
    id: cellNumber(row[at('id')]) ?? 0,
    parent: cellNumber(row[at('parent_id')]),
    row,
  }));
  const childrenOf = (id: number): PlanNode[] =>
    entries
      .filter((entry) => entry.parent === id)
      .map((entry) => toNode(entry.row, at, childrenOf(entry.id)));
  const tops = entries.filter((entry) => entry.parent === undefined);
  const roots = tops.map((entry) => toNode(entry.row, at, childrenOf(entry.id)));
  const root =
    roots.length === 1 && roots[0] !== undefined
      ? roots[0]
      : planNode({ operation: 'Query', children: roots });
  return { root, analyzed: false, properties: [], notes: [], raw };
}

function toNode(
  row: readonly CellValue[],
  at: (name: string) => number,
  children: PlanNode[],
): PlanNode {
  const get = (name: string): string | undefined => {
    const value = cellText(row[at(name)]);
    return value === '' ? undefined : value;
  };
  const operation = [get('operation'), get('options')]
    .filter((part) => part !== undefined)
    .join(' ');
  const alias = get('object_alias')?.replace(/"/gu, '').replace(/@.*$/u, '');
  const name = get('object_name');
  const access = get('access_predicates');
  const filter = get('filter_predicates');
  const warnings: PlanWarning[] = [];
  if (
    /^TABLE ACCESS (FULL|STORAGE FULL)/u.test(operation) ||
    /^INDEX (FAST )?FULL SCAN/u.test(operation)
  ) {
    warnings.push('full-scan');
  }
  if (/^SORT (ORDER BY|GROUP BY|UNIQUE|JOIN)/u.test(operation)) {
    warnings.push('sort');
  }
  if (operation.includes('CARTESIAN')) {
    warnings.push('no-join-predicate');
  }
  const properties: [string, string][] = [];
  for (const column of [
    'object_owner',
    'object_type',
    'bytes',
    'cpu_cost',
    'io_cost',
    'time',
    'optimizer',
    'qblock_name',
    'access_predicates',
    'filter_predicates',
  ]) {
    const value = get(column);
    if (value !== undefined) {
      properties.push([column, value]);
    }
  }
  return planNode({
    operation,
    object:
      name === undefined
        ? undefined
        : alias !== undefined &&
            alias.toLowerCase() !== name.toLowerCase() &&
            !alias.startsWith('VW_')
          ? `${name} ${alias}`
          : name,
    detail:
      access !== undefined
        ? `access: ${access}`
        : filter !== undefined
          ? `filter: ${filter}`
          : undefined,
    cost: cellNumber(row[at('cost')]),
    rows: cellNumber(row[at('cardinality')]),
    warnings,
    properties,
    children,
  });
}
