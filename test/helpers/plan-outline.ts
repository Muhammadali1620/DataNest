// A query plan as indented lines, so a test can see the whole tree at a glance.

import type { PlanNode, QueryPlan } from '../../src/shared/query-plan';

export function outline(plan: QueryPlan | PlanNode): string[] {
  const lines: string[] = [];
  const walk = (node: PlanNode, depth: number): void => {
    const parts = [
      node.operation,
      node.object === undefined ? '' : `[${node.object}]`,
      node.warnings.length === 0 ? '' : `!${node.warnings.join(',')}`,
    ].filter((part) => part !== '');
    lines.push(`${'  '.repeat(depth)}${parts.join(' ')}`);
    for (const child of node.children) {
      walk(child, depth + 1);
    }
  };
  walk('root' in plan ? plan.root : plan, 0);
  return lines;
}
