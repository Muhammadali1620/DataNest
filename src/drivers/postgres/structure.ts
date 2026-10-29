// The structure of an existing PostgreSQL table for the designer. Defaults come as
// the server prints them; identity columns count as auto-numbered, while a serial
// column keeps its honest nextval(…) default.

import { DbError } from '../../core/errors';
import type { ColumnDetail, TableRef, TableStructure } from '../../core/model/objects';
import type { MetadataReader } from '../driver';
import type { PgRowReader } from './definitions';
import { generatedColumnSql } from './server';

export async function readPgStructure(
  read: PgRowReader,
  table: TableRef,
  reader: Pick<MetadataReader, 'listIndexes' | 'listForeignKeys'>,
): Promise<TableStructure> {
  const [relation] = await read(
    `SELECT c.oid::text, obj_description(c.oid, 'pg_class'),
            (SELECT conname FROM pg_constraint WHERE conrelid = c.oid AND contype = 'p')
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
    [table.schema ?? 'public', table.name],
  );
  if (relation === undefined) {
    throw new DbError('not-found', `${table.name} does not exist`);
  }
  const rows = await read(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod), NOT a.attnotnull,
            pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, ${generatedColumnSql(read.server)},
            col_description(a.attrelid, a.attnum)
     FROM pg_attribute a
     -- CockroachDB keeps an identity column's nextval as its default; it is not one.
     LEFT JOIN pg_attrdef d
       ON d.adrelid = a.attrelid AND d.adnum = a.attnum AND a.attidentity::text = ''
     WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [relation[0]],
  );
  const columns = rows.map((row): ColumnDetail => {
    const generated = text(row[5]) !== '';
    // A generated column's expression is not a default.
    const defaultExpression = generated ? undefined : optional(row[3]);
    const comment = optional(row[6]);
    return {
      name: text(row[0]),
      dataType: text(row[1]),
      nullable: row[2] === true,
      autoIncrement: text(row[4]) !== '',
      generated,
      ...(defaultExpression === undefined ? {} : { defaultExpression }),
      ...(comment === undefined ? {} : { comment }),
    };
  });
  const indexes = await reader.listIndexes(table);
  const comment = optional(relation[1]);
  const primaryKeyName = optional(relation[2]);
  return {
    columns,
    primaryKey: indexes.find((index) => index.primary)?.columns ?? [],
    indexes,
    foreignKeys: await reader.listForeignKeys(table),
    ...(comment === undefined ? {} : { comment }),
    ...(primaryKeyName === undefined ? {} : { primaryKeyName }),
  };
}

// A Map, not an object literal: a stray code like `toString` must find nothing.
const ACTIONS: ReadonlyMap<string, string> = new Map([
  ['a', 'NO ACTION'],
  ['r', 'RESTRICT'],
  ['c', 'CASCADE'],
  ['n', 'SET NULL'],
  ['d', 'SET DEFAULT'],
]);

/** confdeltype / confupdtype letters as SQL words. */
export function pgReferentialAction(code: string | undefined): string | undefined {
  return code === undefined ? undefined : ACTIONS.get(code);
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function optional(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
