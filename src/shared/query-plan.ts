// A query plan (V8.2) as both sides see it: a tree of operations with what the
// server estimated and, after EXPLAIN ANALYZE, what really happened. Every database
// says it its own way; the host turns each into this, and the page draws only this.

/** Something in a node that usually costs more than it should. */
export type PlanWarning =
  /** Reads a whole table (or index) row by row. */
  | 'full-scan'
  /** Sorts rows itself, perhaps on disk. */
  | 'sort'
  /** Builds a temporary table. */
  | 'temporary'
  /** Found many times more (or fewer) rows than the planner expected. */
  | 'misestimate'
  /** Ran out of memory and wrote to disk. */
  | 'spill'
  /** Joins without a condition: every row with every row. */
  | 'no-join-predicate'
  /** Converts a column's type, which keeps an index from being used. */
  | 'implicit-conversion'
  /** The planner had no statistics for a column. */
  | 'missing-statistics';

export const PLAN_WARNINGS: readonly PlanWarning[] = [
  'full-scan',
  'sort',
  'temporary',
  'misestimate',
  'spill',
  'no-join-predicate',
  'implicit-conversion',
  'missing-statistics',
];

export interface PlanNode {
  /** What it does, in the server's words: `Seq Scan`, `Hash Join`, `TABLE ACCESS FULL`. */
  readonly operation: string;
  /** The table or index it reads, with an alias where there is one. */
  readonly object?: string;
  /** One line about how: the condition, the key, the sort order. */
  readonly detail?: string;
  /** The planner's cost of this node and everything under it, in its own units. */
  readonly cost?: number;
  /** Rows the planner expected per loop. */
  readonly rows?: number;
  /** Rows really produced per loop (EXPLAIN ANALYZE). */
  readonly actualRows?: number;
  /** How many times the node ran (EXPLAIN ANALYZE). */
  readonly loops?: number;
  /** Milliseconds spent in this node and under it, over all loops (EXPLAIN ANALYZE). */
  readonly timeMs?: number;
  readonly warnings: readonly PlanWarning[];
  /** Everything else the server said about the node, for the details pane. */
  readonly properties: readonly (readonly [string, string])[];
  readonly children: readonly PlanNode[];
}

export interface QueryPlan {
  readonly root: PlanNode;
  /** The statement ran (EXPLAIN ANALYZE): rows and times are real. */
  readonly analyzed: boolean;
  /** About the whole plan: planning and execution time, the server's own totals. */
  readonly properties: readonly (readonly [string, string])[];
  /** Advice the server gave: missing indexes, recommendations. */
  readonly notes: readonly string[];
  /** The server's answer as it came, for "Show the original". */
  readonly raw: string;
}

/** How a node stands out: by its own share of the time (or cost) of the whole plan. */
export type Heat = 'hot' | 'warm' | 'mild' | 'none';

export interface NodeMetrics {
  /** Time (or cost) of the node itself, without what runs under it. */
  readonly self: number;
  /** `self` as a part of the whole plan, 0…1. */
  readonly share: number;
  readonly heat: Heat;
}

/** What the shares are of: real time when the plan ran, otherwise estimated cost. */
export type MetricBasis = 'time' | 'cost' | 'none';

const HEAT_LIMITS: readonly [Heat, number][] = [
  ['hot', 0.5],
  ['warm', 0.2],
  ['mild', 0.05],
];

/** Rows off by this factor (and by enough rows to matter) count as a misestimate. */
export const MISESTIMATE = { factor: 10, rows: 100 } as const;

/**
 * Real time when the plan ran and took any, otherwise estimated cost, where the
 * server gave either; some (SQLite, ClickHouse) give neither.
 */
export function metricBasis(plan: QueryPlan): MetricBasis {
  const nodes = planNodes(plan);
  if (plan.analyzed && nodes.some((node) => (node.timeMs ?? 0) > 0)) {
    return 'time';
  }
  return nodes.some((node) => node.cost !== undefined) ? 'cost' : 'none';
}

/**
 * Self time (or cost) of every node, in pre-order. Servers report both inclusive of
 * the children, so a node's own part is its value minus theirs, never below zero; a
 * node without a value of its own (a MySQL sort before ANALYZE) counts as the sum of
 * its children.
 */
export function planMetrics(plan: QueryPlan): NodeMetrics[] {
  const basis = metricBasis(plan);
  const own = (node: PlanNode): number | undefined =>
    basis === 'time' ? node.timeMs : basis === 'cost' ? node.cost : undefined;
  const inclusive = new Map<PlanNode, number>();
  const measure = (node: PlanNode): number => {
    const under = node.children.reduce((sum, child) => sum + measure(child), 0);
    const value = own(node) ?? under;
    inclusive.set(node, value);
    return value;
  };
  const total = measure(plan.root);
  return planNodes(plan).map((node) => {
    const under = node.children.reduce((sum, child) => sum + (inclusive.get(child) ?? 0), 0);
    const self = Math.max(0, (inclusive.get(node) ?? 0) - under);
    const share = total > 0 ? Math.min(1, self / total) : 0;
    const heat = HEAT_LIMITS.find(([, limit]) => share >= limit)?.[0] ?? 'none';
    return { self, share, heat };
  });
}

/** Nodes in pre-order, the order of `planMetrics`. */
export function planNodes(plan: QueryPlan): PlanNode[] {
  const nodes: PlanNode[] = [];
  const walk = (node: PlanNode): void => {
    nodes.push(node);
    for (const child of node.children) {
      walk(child);
    }
  };
  walk(plan.root);
  return nodes;
}

/** True when the real rows and the estimate are far apart. */
export function isMisestimate(estimated: number | undefined, actual: number | undefined): boolean {
  if (estimated === undefined || actual === undefined) {
    return false;
  }
  const high = Math.max(estimated, actual);
  const low = Math.max(1, Math.min(estimated, actual));
  return high - low >= MISESTIMATE.rows && high / low >= MISESTIMATE.factor;
}

/** A node as the page lists it: in pre-order, with its depth and its share. */
export interface PlanRow {
  readonly depth: number;
  readonly operation: string;
  readonly object?: string;
  readonly detail?: string;
  readonly cost?: number;
  readonly rows?: number;
  readonly actualRows?: number;
  readonly loops?: number;
  readonly timeMs?: number;
  readonly warnings: PlanWarning[];
  readonly properties: [string, string][];
  readonly self: number;
  readonly share: number;
  readonly heat: Heat;
  /** How many rows follow that belong under this one. */
  readonly descendants: number;
}

export function planRows(plan: QueryPlan): PlanRow[] {
  const metrics = planMetrics(plan);
  const rows: PlanRow[] = [];
  const walk = (node: PlanNode, depth: number): number => {
    const index = rows.length;
    const metric = metrics[index] ?? { self: 0, share: 0, heat: 'none' as const };
    rows.push({
      depth,
      operation: node.operation,
      ...(node.object === undefined ? {} : { object: node.object }),
      ...(node.detail === undefined ? {} : { detail: node.detail }),
      ...(node.cost === undefined ? {} : { cost: node.cost }),
      ...(node.rows === undefined ? {} : { rows: node.rows }),
      ...(node.actualRows === undefined ? {} : { actualRows: node.actualRows }),
      ...(node.loops === undefined ? {} : { loops: node.loops }),
      ...(node.timeMs === undefined ? {} : { timeMs: node.timeMs }),
      warnings: [...node.warnings],
      properties: node.properties.map(([key, value]) => [key, value]),
      self: metric.self,
      share: metric.share,
      heat: metric.heat,
      descendants: 0,
    });
    let count = 0;
    for (const child of node.children) {
      count += 1 + walk(child, depth + 1);
    }
    const row = rows[index];
    if (row !== undefined) {
      rows[index] = { ...row, descendants: count };
    }
    return count;
  };
  walk(plan.root, 0);
  return rows;
}
