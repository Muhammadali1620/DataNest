// A SQL Server table in the parts a dump (V5.2) writes at different places: foreign
// keys cannot be switched off for a load, so they come after the rows, with triggers.

import type { TableRef } from '../../core/model/objects';
import type { MetadataReader, TableDump } from '../driver';
import type { MssqlRowReader } from './catalog';
import { schemaOf } from './catalog';
import { tableParts } from './definitions';

export async function readMssqlTableDump(
  read: MssqlRowReader,
  table: TableRef,
  reader: Pick<MetadataReader, 'listForeignKeys'>,
): Promise<TableDump> {
  const parts = await tableParts(read, table, reader);
  return {
    before: [],
    create: parts.create,
    after: [...parts.keys, ...parts.triggers],
    owns: parts.triggerNames.map((name) => ({
      kind: 'trigger' as const,
      schema: schemaOf(table),
      name,
      table: table.name,
    })),
  };
}
