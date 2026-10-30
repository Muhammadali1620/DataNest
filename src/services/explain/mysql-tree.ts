// MySQL 8 plans (V8.2): `EXPLAIN FORMAT=TREE` and `EXPLAIN ANALYZE` print the same
// indented tree, one operation per line after `->`, with cost and rows in brackets
// and, after ANALYZE, the real time per loop, rows and loops.

import type { PlanNode, PlanWarning, QueryPlan } from '../../shared/query-plan';
import { numberOf, planNode } from './plan-node';

interface Line {
  readonly depth: number;
  readonly text: string;
  readonly cost?: number;
  readonly rows?: number;
  readonly actualRows?: number;
  readonly loops?: number;
  readonly timeMs?: number;
  readonly neverExecuted: boolean;
}

const COST = /\(cost=([\d.e+-]+)(?:\.\.([\d.e+-]+))? rows=([\d.e+-]+)\)/u;
const ACTUAL = /\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+-]+) loops=([\d.e+-]+)\)/u;

export function readMysqlTree(raw: string, analyzed: boolean): QueryPlan {
  const lines: Line[] = [];
  for (const source of raw.split(/\r?\n/u)) {
    const arrow = source.indexOf('-> ');
    if (arrow < 0) {
      // A long operation goes on in the next line; it belongs to the one before.
      const last = lines.pop();
      if (last !== undefined && source.trim() !== '') {
        lines.push({ ...last, text: `${last.text} ${source.trim()}` });
      } else if (last !== undefined) {
        lines.push(last);
      }
      continue;
    }
    lines.push(parseLine(source.slice(0, arrow).length, source.slice(arrow + 3)));
  }
  const roots = build(lines);
  const root =
    roots.length === 1 && roots[0] !== undefined
      ? roots[0]
      : planNode({ operation: 'Query', children: roots });
  return { root, analyzed, properties: [], notes: [], raw };
}

function parseLine(indent: number, body: string): Line {
  const cost = COST.exec(body);
  const actual = ACTUAL.exec(body);
  const loops = numberOf(actual?.[4]);
  const last = numberOf(actual?.[2]);
  let text = body.replace(COST, '').replace(ACTUAL, '');
  const neverExecuted = text.includes('(never executed)');
  text = text.replace('(never executed)', '').trim();
  return {
    depth: Math.floor(indent / 4),
    text,
    ...(cost === null ? {} : { cost: numberOf(cost[2] ?? cost[1]), rows: numberOf(cost[3]) }),
    ...(actual === null
      ? {}
      : {
          actualRows: numberOf(actual[3]),
          loops,
          timeMs: last === undefined ? undefined : last * (loops ?? 1),
        }),
    neverExecuted,
  };
}

/** Lines in order with their depth become the tree. */
function build(lines: readonly Line[]): PlanNode[] {
  let index = 0;
  const level = (depth: number): PlanNode[] => {
    const nodes: PlanNode[] = [];
    while (index < lines.length) {
      const line = lines[index];
      if (line === undefined || line.depth < depth) {
        break;
      }
      index += 1;
      const children = level(line.depth + 1);
      nodes.push(toNode(line, children));
    }
    return nodes;
  };
  return level(0);
}

function toNode(line: Line, children: PlanNode[]): PlanNode {
  const { operation, object, detail } = splitText(line.text);
  const lower = line.text.toLowerCase();
  const warnings: PlanWarning[] = [];
  if (/^table scan on (?!<)/u.test(lower) || lower.startsWith('index scan on')) {
    warnings.push('full-scan');
  }
  if (lower.startsWith('sort') || lower.includes('filesort')) {
    warnings.push('sort');
  }
  if (lower.includes('temporary')) {
    warnings.push('temporary');
  }
  if (lower.startsWith('inner hash join (no condition)') || lower.includes('(no condition)')) {
    warnings.push('no-join-predicate');
  }
  return planNode({
    operation,
    object,
    detail,
    cost: line.cost,
    rows: line.rows,
    actualRows: line.neverExecuted ? 0 : line.actualRows,
    loops: line.neverExecuted ? 0 : line.loops,
    timeMs: line.neverExecuted ? 0 : line.timeMs,
    warnings,
    properties: [
      ['Line', line.text],
      ...(line.neverExecuted ? [['Executed', 'never'] as const] : []),
    ],
    children,
  });
}

/**
 * `Filter: (c.country <> 'XX')` → operation and detail; `Table scan on c` and
 * `Index lookup on o using ix (customer_id=c.id)` → operation, object and detail.
 */
export function splitText(text: string): { operation: string; object?: string; detail?: string } {
  const colon = /^([A-Za-z][A-Za-z -]*?): (.*)$/u.exec(text);
  if (colon !== null) {
    return { operation: colon[1] ?? text, detail: colon[2] ?? '' };
  }
  const on = /^(.*?) on (\S+(?: using \S+)?)(?: \((.*)\))?(.*)$/u.exec(text);
  if (on !== null) {
    const rest = (on[4] ?? '').trim();
    const condition = on[3];
    return {
      operation: on[1] ?? text,
      object: on[2] ?? '',
      ...(condition === undefined && rest === ''
        ? {}
        : {
            detail: [condition, rest].filter((part) => part !== undefined && part !== '').join(' '),
          }),
    };
  }
  return { operation: text };
}
