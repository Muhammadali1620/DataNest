// Plans that come as rows (V8.2): TiDB draws its tree into the `id` column
// (`└─HashJoin_28`), and MySQL before 8.0.16 has only the classic table of EXPLAIN,
// one row per table in join order.

import type { CellValue } from '../../shared/cell-value';
import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { cellNumber, cellText, durationMs, planNode } from './plan-node';

type Row = readonly CellValue[];

export function readTabularPlan(
  columns: readonly string[],
  rows: readonly Row[],
  analyzed: boolean,
  raw: string,
): QueryPlan {
  const at = (name: string): number =>
    columns.findIndex((column) => column.toLowerCase() === name.toLowerCase());
  const root = at('estRows') >= 0 ? tidbTree(rows, at) : classicList(columns, rows, at);
  return { root, analyzed, properties: [], notes: [], raw };
}

const TIDB_SHOWN = new Set(['id', 'estrows', 'actrows', 'access object', 'operator info']);

function tidbTree(rows: readonly Row[], at: (name: string) => number): PlanNode {
  const id = at('id');
  const parsed = rows.map((row) => {
    const text = cellText(row[id]) ?? '';
    const start = text.search(/[A-Za-z]/u);
    return { depth: Math.max(0, start) / 2, name: text.slice(Math.max(0, start)), row };
  });
  let index = 0;
  const level = (depth: number): PlanNode[] => {
    const nodes: PlanNode[] = [];
    while (index < parsed.length) {
      const entry = parsed[index];
      if (entry === undefined || entry.depth < depth) {
        break;
      }
      index += 1;
      const children = level(entry.depth + 1);
      nodes.push(tidbNode(entry.name, entry.row, at, children));
    }
    return nodes;
  };
  const roots = level(0);
  return roots.length === 1 && roots[0] !== undefined
    ? roots[0]
    : planNode({ operation: 'Query', children: roots });
}

function tidbNode(
  name: string,
  row: Row,
  at: (name: string) => number,
  children: PlanNode[],
): PlanNode {
  const match = /^([A-Za-z]+)(?:_\d+)?(?:\((\w+)\))?/u.exec(name);
  const operation = match?.[1] ?? name;
  const info = cellText(row[at('operator info')]) ?? '';
  const execution = cellText(row[at('execution info')]) ?? '';
  const warnings: PlanWarning[] = [];
  if (operation.endsWith('FullScan')) {
    warnings.push('full-scan');
  }
  if (/Sort|TopN/u.test(operation)) {
    warnings.push('sort');
  }
  if (info.includes('stats:pseudo')) {
    warnings.push('missing-statistics');
  }
  const time = /(?:^|[\s,{])time:([\d.]+)(ns|µs|us|ms|s)\b/u.exec(execution);
  const properties: [string, string][] = [['Id', name]];
  if (match?.[2] !== undefined) {
    properties.push(['Side', match[2]]);
  }
  const headers = ['task', 'execution info', 'memory', 'disk'];
  for (const header of headers) {
    const value = cellText(row[at(header)]);
    if (value !== undefined && value !== '' && !TIDB_SHOWN.has(header)) {
      properties.push([header, value]);
    }
  }
  return planNode({
    operation,
    object: cellText(row[at('access object')]),
    detail: info,
    rows: cellNumber(row[at('estRows')]),
    actualRows: cellNumber(row[at('actRows')]),
    timeMs: time === null ? undefined : durationMs(Number(time[1]), time[2] ?? 'ms'),
    warnings,
    properties,
    children,
  });
}

const CLASSIC_ACCESS: Readonly<Record<string, string>> = {
  ALL: 'Full table scan',
  index: 'Full index scan',
  range: 'Index range scan',
  ref: 'Index lookup',
  eq_ref: 'Unique index lookup',
  const: 'Constant row',
  system: 'Constant row',
};

function classicList(
  columns: readonly string[],
  rows: readonly Row[],
  at: (name: string) => number,
): PlanNode {
  const children = rows.map((row) => {
    const type = cellText(row[at('type')]) ?? '';
    const extra = cellText(row[at('Extra')]) ?? '';
    const key = cellText(row[at('key')]);
    const table = cellText(row[at('table')]) ?? '';
    const warnings: PlanWarning[] = [];
    if (type === 'ALL' || type === 'index') {
      warnings.push('full-scan');
    }
    if (extra.includes('filesort')) {
      warnings.push('sort');
    }
    if (extra.includes('temporary')) {
      warnings.push('temporary');
    }
    return planNode({
      operation: CLASSIC_ACCESS[type] ?? (type === '' ? 'Step' : type),
      object: key === undefined ? table : `${table} using ${key}`,
      detail: extra,
      rows: cellNumber(row[at('rows')]),
      warnings,
      properties: columns.flatMap((column, index): [string, string][] => {
        const value = cellText(row[index]);
        return value === undefined || value === '' ? [] : [[column, value]];
      }),
    });
  });
  return planNode({ operation: 'Query', children });
}
