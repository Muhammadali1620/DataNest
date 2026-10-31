// Where a schema comparison (V8.3) starts, read off the clicked tree item. Free of
// `vscode`, so every kind of item is covered by unit tests.

import type { ObjectScope, TableRef } from '../../core/model/objects';
import { type TreeNode, scopeOf } from './nodes';

export interface CompareStart {
  readonly connectionId: string;
  /** Known scope; undefined when the user still has to pick it. */
  readonly scope: ObjectScope | undefined;
}

export function compareStartOf(target: TreeNode): CompareStart | undefined {
  switch (target.kind) {
    case 'database':
    case 'schema':
      return { connectionId: target.connectionId, scope: scopeOf(target) };
    case 'connection':
      return { connectionId: target.connectionId, scope: undefined };
    case 'group':
    case 'table':
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

/** `Local · shop.public`; just the connection where it is the scope (SQLite). */
export function scopeLabel(connectionName: string, scope: ObjectScope): string {
  const where = [scope.database, scope.schema].filter((part) => part !== undefined).join('.');
  return where === '' ? connectionName : `${connectionName} · ${where}`;
}

/** `Local · shop.public.orders`: the connection, then the table with its scope. */
export function tableLabel(connectionName: string, table: TableRef): string {
  const name = [table.database, table.schema, table.name]
    .filter((part) => part !== undefined)
    .join('.');
  return `${connectionName} · ${name}`;
}
