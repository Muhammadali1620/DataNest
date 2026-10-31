// The argument of `datanest.table.properties`, which other pages call to open a table's
// properties on a tab. Anything that does not look like one is ignored.

import type { ObjectScope } from '../../core/model/objects';
import { TABLE_TABS, type TableTab } from '../../shared/protocols/table-designer';

export function propertiesTarget(
  arg: unknown,
):
  | { connectionId: string; scope: ObjectScope; table: string; tab: TableTab | undefined }
  | undefined {
  if (typeof arg !== 'object' || arg === null) {
    return undefined;
  }
  const { connectionId, scope, table, tab } = arg as Record<string, unknown>;
  if (typeof connectionId !== 'string' || typeof table !== 'string' || table === '') {
    return undefined;
  }
  const own =
    typeof scope === 'object' && scope !== null
      ? (scope as { database?: unknown; schema?: unknown })
      : {};
  const text = (value: unknown): string | undefined =>
    typeof value === 'string' && value !== '' ? value : undefined;
  const database = text(own.database);
  const schema = text(own.schema);
  return {
    connectionId,
    table,
    scope: {
      ...(database === undefined ? {} : { database }),
      ...(schema === undefined ? {} : { schema }),
    },
    tab: TABLE_TABS.find((known) => known === tab),
  };
}
