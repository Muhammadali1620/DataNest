// CockroachDB plans (V8.2): `EXPLAIN` and `EXPLAIN ANALYZE` print a tree of `• name`
// lines joined by `│ ├── └──`, each followed by `key: value` lines. Lines before the
// tree describe the whole statement; index recommendations come after it.

import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { durationMs, numberOf, planNode } from './plan-node';

interface Draft {
  readonly depth: number;
  readonly name: string;
  readonly properties: [string, string][];
}

const DETAIL_KEYS = ['equality', 'filter', 'order', 'group by', 'spans', 'lookup condition'];

export function readCockroachPlan(raw: string, analyzed: boolean): QueryPlan {
  const drafts: Draft[] = [];
  const properties: [string, string][] = [];
  const notes: string[] = [];
  let afterTree = false;
  for (const line of raw.split(/\r?\n/u)) {
    const bullet = line.indexOf('• ');
    if (bullet >= 0 && !afterTree) {
      drafts.push({
        depth: Math.round(bullet / 4),
        name: line.slice(bullet + 2).trim(),
        properties: [],
      });
      continue;
    }
    const text = line.replace(/^[\s│├└─]+/u, '').trim();
    if (text === '') {
      continue;
    }
    const pair = /^([^:]+):\s*(.*)$/u.exec(text);
    const last = drafts.at(-1);
    // Indented lines belong to the node above, `key: value` or a bare remark.
    if (last !== undefined && !afterTree && /^[\s│├└─]/u.test(line)) {
      last.properties.push(pair === null ? [text, ''] : [pair[1] ?? '', pair[2] ?? '']);
      continue;
    }
    if (drafts.length > 0) {
      afterTree = true;
    }
    if (afterTree) {
      const command = /SQL command:\s*(.+)$/u.exec(text);
      if (command?.[1] !== undefined) {
        notes.push(command[1]);
      }
      continue;
    }
    if (pair !== null) {
      properties.push([pair[1] ?? '', pair[2] ?? '']);
    }
  }
  let index = 0;
  const level = (depth: number): PlanNode[] => {
    const nodes: PlanNode[] = [];
    while (index < drafts.length) {
      const draft = drafts[index];
      if (draft === undefined || draft.depth < depth) {
        break;
      }
      index += 1;
      nodes.push(toNode(draft, level(draft.depth + 1)));
    }
    return nodes;
  };
  const roots = level(0);
  const root =
    roots.length === 1 && roots[0] !== undefined
      ? roots[0]
      : planNode({ operation: 'Query', children: roots });
  return { root, analyzed, properties, notes, raw };
}

function toNode(draft: Draft, children: PlanNode[]): PlanNode {
  const get = (key: string): string | undefined =>
    draft.properties.find(([name]) => name === key)?.[1];
  const warnings: PlanWarning[] = [];
  const spans = get('spans');
  if (spans === 'FULL SCAN' || spans?.startsWith('FULL SCAN') === true) {
    warnings.push('full-scan');
  }
  if (draft.name === 'sort') {
    warnings.push('sort');
  }
  if (draft.name.startsWith('cross join')) {
    warnings.push('no-join-predicate');
  }
  const time = /^([\d.]+)\s*(ns|µs|us|ms|s|m)$/u.exec(get('execution time') ?? '');
  const detailKey = DETAIL_KEYS.find(
    (key) => get(key) !== undefined && !(key === 'spans' && warnings.includes('full-scan')),
  );
  return planNode({
    operation: draft.name,
    object: get('table'),
    detail: detailKey === undefined ? undefined : `${detailKey}: ${get(detailKey) ?? ''}`,
    rows: numberOf(/^[\d.]+/u.exec(get('estimated row count')?.replace(/,/gu, '') ?? '')?.[0]),
    actualRows: numberOf(get('actual row count')?.replace(/,/gu, '')),
    timeMs: time === null ? undefined : durationMs(Number(time[1]), time[2] ?? 'ms'),
    warnings,
    properties: draft.properties,
    children,
  });
}
