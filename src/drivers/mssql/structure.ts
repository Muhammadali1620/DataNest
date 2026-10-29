// The structure of an existing SQL Server table for the designer. Defaults come
// without the parentheses the server wraps them in; descriptions are the
// `MS_Description` extended properties the server's own tools write.

import { DbError } from '../../core/errors';
import type { ColumnDetail, TableRef, TableStructure } from '../../core/model/objects';
import type { MetadataReader } from '../driver';
import {
  DESCRIPTION,
  flag,
  type MssqlRowReader,
  objectName,
  optionalText,
  text,
  TYPE_TEXT,
  unwrapDefault,
} from './catalog';

export async function readMssqlStructure(
  read: MssqlRowReader,
  table: TableRef,
  reader: Pick<MetadataReader, 'listIndexes' | 'listForeignKeys'>,
): Promise<TableStructure> {
  const [relation] = await read(
    `SELECT CAST(t.object_id AS varchar(20)),
            CAST((SELECT value FROM sys.extended_properties
                  WHERE class = 1 AND major_id = t.object_id AND minor_id = 0 AND name = @p2)
                 AS nvarchar(max)),
            (SELECT name FROM sys.key_constraints WHERE parent_object_id = t.object_id AND type = 'PK')
     FROM sys.tables t WHERE t.object_id = OBJECT_ID(@p1)`,
    [objectName(table), DESCRIPTION],
  );
  if (relation === undefined) {
    throw new DbError('not-found', `${table.name} does not exist`);
  }
  const rows = await read(
    `SELECT c.name, ${TYPE_TEXT}, c.is_nullable, dc.definition, c.is_identity, c.is_computed,
            CAST(ep.value AS nvarchar(max))
     FROM sys.columns c
     JOIN sys.types t ON t.user_type_id = c.user_type_id
     LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
     LEFT JOIN sys.extended_properties ep
       ON ep.class = 1 AND ep.major_id = c.object_id AND ep.minor_id = c.column_id AND ep.name = @p2
     WHERE c.object_id = OBJECT_ID(@p1)
     ORDER BY c.column_id`,
    [objectName(table), DESCRIPTION],
  );
  const columns = rows.map((row): ColumnDetail => {
    const defaultExpression = optionalText(row[3]);
    const comment = optionalText(row[6]);
    return {
      name: text(row[0]),
      dataType: text(row[1]),
      nullable: flag(row[2]),
      autoIncrement: flag(row[4]),
      generated: flag(row[5]),
      ...(defaultExpression === undefined
        ? {}
        : { defaultExpression: unwrapDefault(defaultExpression) }),
      ...(comment === undefined || comment === '' ? {} : { comment }),
    };
  });
  const indexes = await reader.listIndexes(table);
  const comment = optionalText(relation[1]);
  const primaryKeyName = optionalText(relation[2]);
  return {
    columns,
    primaryKey: indexes.find((index) => index.primary)?.columns ?? [],
    indexes,
    foreignKeys: await reader.listForeignKeys(table),
    ...(comment === undefined || comment === '' ? {} : { comment }),
    ...(primaryKeyName === undefined ? {} : { primaryKeyName }),
  };
}

// A Map, not an object literal: a stray name like `toString` must find nothing.
const ACTIONS: ReadonlyMap<string, string> = new Map([
  ['NO_ACTION', 'NO ACTION'],
  ['CASCADE', 'CASCADE'],
  ['SET_NULL', 'SET NULL'],
  ['SET_DEFAULT', 'SET DEFAULT'],
]);

/** `*_referential_action_desc` as SQL words. */
export function mssqlReferentialAction(code: string | undefined): string | undefined {
  return code === undefined ? undefined : ACTIONS.get(code);
}
