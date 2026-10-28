// How a found object reads in the search list and what choosing it does. Free of
// `vscode`, so the wording and the actions are unit-tested.

import type { ObjectRef } from '../../core/model/objects';
import type { IndexedObject } from '../../services/object-index';
import type { TableNode } from '../tree/nodes';

const ICONS: Readonly<Record<IndexedObject['kind'], string>> = {
  table: 'table',
  view: 'eye',
  function: 'symbol-function',
  procedure: 'symbol-method',
  trigger: 'zap',
  sequence: 'symbol-number',
  event: 'calendar',
};

export function objectLabel(object: IndexedObject): string {
  const name = object.signature === undefined ? object.name : `${object.name}(${object.signature})`;
  return `$(${ICONS[object.kind]}) ${name}`;
}

/** `Local MySQL · shop`, `Prod · app.sales`, with the table of a trigger. */
export function objectDescription(object: IndexedObject, connectionName: string): string {
  const where = [object.database, object.schema].filter((part) => part !== undefined).join('.');
  const parts = [connectionName, ...(where === '' ? [] : [where])];
  if (object.table !== undefined) {
    parts.push(`→ ${object.table}`);
  }
  return parts.join(' · ');
}

/** Same names together, then by connection, kind and place. */
export function compareObjects(
  a: IndexedObject,
  b: IndexedObject,
  connectionName: (id: string) => string,
): number {
  return (
    a.name.localeCompare(b.name) ||
    connectionName(a.connectionId).localeCompare(connectionName(b.connectionId)) ||
    a.kind.localeCompare(b.kind) ||
    objectDescription(a, '').localeCompare(objectDescription(b, ''))
  );
}

export type ObjectAction =
  | { readonly kind: 'open-table'; readonly node: TableNode }
  | { readonly kind: 'definition'; readonly object: ObjectRef };

/** Tables and views open as data; everything else shows its definition. */
export function defaultAction(object: IndexedObject): ObjectAction {
  const scope = {
    ...(object.database === undefined ? {} : { database: object.database }),
    ...(object.schema === undefined ? {} : { schema: object.schema }),
  };
  if (object.kind === 'table' || object.kind === 'view') {
    return {
      kind: 'open-table',
      node: {
        kind: 'table',
        connectionId: object.connectionId,
        scope,
        name: object.name,
        tableKind: object.kind,
        ...(object.materialized === true ? { materialized: true } : {}),
      },
    };
  }
  return { kind: 'definition', object: definitionRef(object) };
}

/** The object as a reference for its DDL. */
export function definitionRef(object: IndexedObject): ObjectRef {
  return {
    ...(object.database === undefined ? {} : { database: object.database }),
    ...(object.schema === undefined ? {} : { schema: object.schema }),
    kind: object.kind,
    name: object.name,
    ...(object.signature === undefined ? {} : { signature: object.signature }),
    ...(object.table === undefined ? {} : { table: object.table }),
    ...(object.materialized === true ? { materialized: true } : {}),
  };
}
