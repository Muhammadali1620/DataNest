// What an ER diagram (V8.1) shows, read off the clicked tree item and the selection.
// Free of `vscode`, so every kind of item is covered by unit tests.

import type { ObjectScope } from '../../core/model/objects';
import { type TreeNode, scopeOf } from './nodes';

export interface DiagramStart {
  readonly connectionId: string;
  /** Known scope; undefined when the user still has to pick a database or schema. */
  readonly scope: ObjectScope | undefined;
  /** Only these tables; the whole scope when absent. */
  readonly tables?: readonly string[];
}

/**
 * A database, schema or the Tables folder shows every table in it; tables selected
 * together show just them (those of the clicked table's scope) and what they point
 * at; a connection still needs its scope picked.
 */
export function diagramStartOf(
  target: TreeNode,
  selection: readonly TreeNode[] | undefined,
): DiagramStart | undefined {
  switch (target.kind) {
    case 'table': {
      if (target.tableKind !== 'table') {
        return undefined;
      }
      const scope = scopeOf(target);
      const key = JSON.stringify(scope);
      const picked = (selection ?? [target]).filter(
        (node): node is Extract<TreeNode, { kind: 'table' }> =>
          node.kind === 'table' &&
          node.tableKind === 'table' &&
          node.connectionId === target.connectionId &&
          JSON.stringify(scopeOf(node)) === key,
      );
      const names = picked.some((node) => node.name === target.name)
        ? picked.map((node) => node.name)
        : [target.name];
      return { connectionId: target.connectionId, scope, tables: names };
    }
    case 'group':
      return target.group === 'tables'
        ? { connectionId: target.connectionId, scope: target.scope }
        : undefined;
    case 'database':
    case 'schema':
      return { connectionId: target.connectionId, scope: scopeOf(target) };
    case 'connection':
      return { connectionId: target.connectionId, scope: undefined };
    case 'project':
    case 'connectionFolder':
    case 'column':
    case 'folder':
    case 'object':
    case 'index':
    case 'foreignKey':
    case 'queryFolder':
    case 'savedQuery':
    case 'security':
    case 'securityGroup':
    case 'account':
    case 'redisDatabase':
    case 'mongoDatabase':
    case 'mongoCollection':
    case 'mongoIndex':
    case 'elasticIndex':
    case 'elasticField':
    case 'redisFolder':
    case 'redisKey':
    case 'redisMore':
    case 'message':
      return undefined;
  }
}

/** `shop.public`, or the connection's name where the connection is the scope (SQLite). */
export function diagramTitle(
  scope: ObjectScope,
  tables: readonly string[] | undefined,
  connectionName: string,
): string {
  const where = [scope.database, scope.schema].filter((part) => part !== undefined).join('.');
  const base = where === '' ? connectionName : where;
  if (tables === undefined) {
    return base;
  }
  return tables.length === 1 ? `${base}.${tables[0] ?? ''}` : `${base} (${tables.length})`;
}
