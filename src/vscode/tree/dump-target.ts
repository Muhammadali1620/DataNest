// Where a dump (V5.2) starts from, read off the clicked tree item and the selection.
// Free of `vscode`, so every kind of item is covered by unit tests.

import type { ObjectScope, TableKind } from '../../core/model/objects';
import { type TreeNode, scopeOf } from './nodes';

export interface DumpStart {
  readonly connectionId: string;
  /** Known scope; undefined when the user still has to pick a database or schema. */
  readonly scope: ObjectScope | undefined;
  /** Relations to tick in the list; undefined ticks all of them (of `only`'s kind). */
  readonly preselect: readonly string[] | undefined;
  /** Tick only tables, or only views: the Tables or Views folder was clicked. */
  readonly only?: TableKind;
  /** Offer the routines, events, sequences and types of the scope too. */
  readonly wholeScope: boolean;
}

/**
 * Tables and views selected together dump just them (only those of the clicked
 * item's scope); a database, schema or folder dumps everything in it; a connection
 * still needs its database picked, unless it is a single file.
 */
export function dumpStartOf(
  target: TreeNode,
  selection: readonly TreeNode[] | undefined,
): DumpStart | undefined {
  switch (target.kind) {
    case 'table': {
      const scope = scopeOf(target);
      const key = JSON.stringify(scope);
      const picked = (selection ?? [target]).filter(
        (node): node is Extract<TreeNode, { kind: 'table' }> =>
          node.kind === 'table' &&
          node.connectionId === target.connectionId &&
          JSON.stringify(scopeOf(node)) === key,
      );
      const names = picked.some((node) => node.name === target.name)
        ? picked.map((node) => node.name)
        : [target.name];
      return { connectionId: target.connectionId, scope, preselect: names, wholeScope: false };
    }
    case 'group':
      if (target.group !== 'tables' && target.group !== 'views') {
        return undefined;
      }
      return {
        connectionId: target.connectionId,
        scope: target.scope,
        preselect: undefined,
        only: target.group === 'tables' ? 'table' : 'view',
        wholeScope: false,
      };
    case 'database':
    case 'schema':
      return {
        connectionId: target.connectionId,
        scope: scopeOf(target),
        preselect: undefined,
        wholeScope: true,
      };
    case 'connection':
      return {
        connectionId: target.connectionId,
        scope: undefined,
        preselect: undefined,
        wholeScope: true,
      };
    case 'project':
    case 'connectionFolder':
    case 'column':
    case 'folder':
    case 'object':
    case 'index':
    case 'foreignKey':
    case 'message':
      return undefined;
  }
}

/** `shop-2026-10-29-1405.sql`: the name of what is dumped and when, safe on every platform. */
export function dumpFileName(name: string, date: Date): string {
  const safe = name
    // eslint-disable-next-line no-control-regex -- control characters are what it removes
    .replace(/[<>:"/\\|?*\u0000-\u001f]+/gu, '-')
    .replace(/^[\s.-]+|[\s.-]+$/gu, '')
    .slice(0, 60);
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}-${pad(
    date.getHours(),
  )}${pad(date.getMinutes())}`;
  return `${safe === '' ? 'dump' : safe}-${stamp}.sql`;
}
