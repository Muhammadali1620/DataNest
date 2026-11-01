// What a tree node types into a text editor when it is dragged there (V13.4): its name,
// quoted the way the connection's database quotes it. Free of `vscode`, so the rules are
// unit-tested; the drag controller only looks the dialect up and joins the lines.

import type { Dialect } from '../../drivers/driver';
import type { TreeNode } from './nodes';

/** Kinds of nodes that are an SQL name. */
const NAMED_KINDS: ReadonlySet<TreeNode['kind']> = new Set([
  'database',
  'schema',
  'table',
  'object',
  'column',
]);

/** Whether a node can be dragged as a name; the connection is then asked for its dialect. */
export function hasDragText(node: TreeNode): boolean {
  return NAMED_KINDS.has(node.kind);
}

/** The connection of a node that can be dragged as a name. */
export function dragConnectionOf(node: TreeNode): string | undefined {
  return hasDragText(node) && 'connectionId' in node && typeof node.connectionId === 'string'
    ? node.connectionId
    : undefined;
}

/**
 * The text of one node, or undefined for a node that is not an SQL name (a folder, a
 * connection, a key). Names only ever pass through the dialect's quoting.
 */
export function dragTextOf(node: TreeNode, dialect: Dialect): string | undefined {
  if (node.kind === 'database') {
    return dialect.quoteIdentifier(node.database);
  }
  if (node.kind === 'schema') {
    return dialect.quoteIdentifier(node.schema);
  }
  if (node.kind === 'table') {
    return dialect.quoteTable({ ...node.scope, name: node.name });
  }
  if (node.kind === 'object') {
    return dialect.quoteTable({
      ...(node.object.database === undefined ? {} : { database: node.object.database }),
      ...(node.object.schema === undefined ? {} : { schema: node.object.schema }),
      name: node.object.name,
    });
  }
  if (node.kind === 'column') {
    return dialect.quoteIdentifier(node.column.name);
  }
  return undefined;
}

/** The nodes' names, one per line, in the order they were dragged. */
export function dragTextOfAll(
  nodes: readonly TreeNode[],
  dialectOf: (connectionId: string) => Dialect | undefined,
): string {
  const lines: string[] = [];
  for (const node of nodes) {
    const connectionId = dragConnectionOf(node);
    if (connectionId === undefined) {
      continue;
    }
    const dialect = dialectOf(connectionId);
    const text = dialect === undefined ? undefined : dragTextOf(node, dialect);
    if (text !== undefined) {
      lines.push(text);
    }
  }
  return lines.join('\n');
}
