// Where the Manager page (V11.13) starts from, read off the clicked tree item or the
// argument another page passes. Free of `vscode`, so every kind of item is covered by
// unit tests.

import { type ManagerSection, MANAGER_SECTIONS } from '../../shared/protocols/manager';
import { type TreeNode, scopeOf } from './nodes';

export interface ManagerTarget {
  readonly connectionId: string;
  readonly database?: string;
  readonly schema?: string;
  readonly table?: { readonly name: string; readonly kind: 'table' | 'view' };
  readonly section?: ManagerSection;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** A tree item: its connection, and the database, schema and table it stands in. */
export function managerTargetOfNode(
  node: TreeNode,
  section?: ManagerSection,
): ManagerTarget | undefined {
  const base = (
    connectionId: string,
    scope: { database?: string; schema?: string },
  ): ManagerTarget => ({
    connectionId,
    ...(scope.database === undefined ? {} : { database: scope.database }),
    ...(scope.schema === undefined ? {} : { schema: scope.schema }),
    ...(section === undefined ? {} : { section }),
  });
  switch (node.kind) {
    case 'connection':
      return base(node.connectionId, {});
    case 'database':
    case 'schema':
    case 'group':
    case 'queryFolder':
      return base(node.connectionId, scopeOf(node));
    case 'table':
      return {
        ...base(node.connectionId, scopeOf(node)),
        table: { name: node.name, kind: node.tableKind },
      };
    case 'column':
    case 'folder':
    case 'index':
    case 'foreignKey':
      return {
        ...base(node.connectionId, scopeOf(node)),
        table: { name: node.table.name, kind: 'table' },
      };
    case 'project':
    case 'connectionFolder':
    case 'object':
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

/**
 * The argument of `datanest.manager.open`: a tree item, a connection id, or
 * `{ connectionId, scope?, table?, section? }` from another page.
 */
export function managerTargetOf(
  value: unknown,
  isNode: (value: unknown) => value is TreeNode,
  section?: ManagerSection,
): ManagerTarget | undefined {
  if (isNode(value)) {
    return managerTargetOfNode(value, section);
  }
  if (typeof value === 'string' && value !== '') {
    return { connectionId: value, ...(section === undefined ? {} : { section }) };
  }
  if (!isRecord(value)) {
    return undefined;
  }
  const connectionId = text(value.connectionId);
  if (connectionId === undefined) {
    return undefined;
  }
  const scope = isRecord(value.scope) ? value.scope : {};
  const database = text(scope.database);
  const schema = text(scope.schema);
  const tableValue = value.table;
  const tableName =
    typeof tableValue === 'string'
      ? text(tableValue)
      : isRecord(tableValue)
        ? text(tableValue.name)
        : undefined;
  const kind = isRecord(tableValue) && tableValue.kind === 'view' ? 'view' : 'table';
  const asked = value.section;
  const wanted = MANAGER_SECTIONS.find((candidate) => candidate === asked) ?? section;
  return {
    connectionId,
    ...(database === undefined ? {} : { database }),
    ...(schema === undefined ? {} : { schema }),
    ...(tableName === undefined ? {} : { table: { name: tableName, kind } }),
    ...(wanted === undefined ? {} : { section: wanted }),
  };
}
