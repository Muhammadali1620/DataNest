// SQLite plans (V8.2): `EXPLAIN QUERY PLAN` gives rows of id, parent and a line of
// text; the parent ids make the tree. SQLite has no costs and no EXPLAIN ANALYZE.

import type { CellValue } from '../../shared/cell-value';
import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { cellNumber, cellText, planNode } from './plan-node';

export function readSqlitePlan(rows: readonly (readonly CellValue[])[], raw: string): QueryPlan {
  const entries = rows.map((row) => ({
    id: cellNumber(row[0]) ?? 0,
    parent: cellNumber(row[1]) ?? 0,
    detail: cellText(row[3]) ?? '',
  }));
  const ids = new Set(entries.map((entry) => entry.id));
  const childrenOf = (parent: number): PlanNode[] =>
    entries
      .filter((entry) => entry.parent === parent && entry.id !== parent)
      .map((entry) => toNode(entry.detail, childrenOf(entry.id)));
  // Rows whose parent is not listed hang from the top, whatever its id (0 in every version).
  const tops = entries.filter((entry) => !ids.has(entry.parent) || entry.parent === entry.id);
  const roots = tops.map((entry) => toNode(entry.detail, childrenOf(entry.id)));
  return {
    root: planNode({ operation: 'Query', children: roots }),
    analyzed: false,
    properties: [],
    notes: [],
    raw,
  };
}

function toNode(detail: string, children: PlanNode[]): PlanNode {
  const warnings: PlanWarning[] = [];
  const access = /^(SCAN|SEARCH) (\S+)(?: (?:AS \S+ )?USING (.+))?$/u.exec(detail);
  if (access !== null) {
    const how = access[3];
    if (access[1] === 'SCAN' && how?.includes('INDEX') !== true) {
      warnings.push('full-scan');
    }
    return planNode({
      operation: access[1] === 'SCAN' ? 'Scan' : 'Search',
      object: access[2],
      detail: how === undefined ? undefined : `using ${how}`,
      warnings,
      properties: [['Detail', detail]],
      children,
    });
  }
  if (detail.startsWith('USE TEMP B-TREE')) {
    warnings.push(detail.includes('ORDER BY') ? 'sort' : 'temporary');
  }
  return planNode({ operation: detail, warnings, properties: [['Detail', detail]], children });
}
