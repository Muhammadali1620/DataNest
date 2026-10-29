// A table's definition split for a dump (V5.2), and the types a dump needs first.
// Foreign keys become ALTER TABLE statements that run after every table is filled,
// so tables load in any order (cycles included) without turning checks off, which
// PostgreSQL allows only to superusers. Sequences of serial columns come first,
// because the column default names them.

import { DbError } from '../../core/errors';
import type { ObjectRef, TableRef } from '../../core/model/objects';
import type { TableDump, TypeDump } from '../driver';
import {
  columnComments,
  columnLines,
  constraintLines,
  indexStatements,
  optionalText,
  type PgRowReader,
  sequenceDefinition,
  tableTriggers,
  text,
} from './definitions';
import { literal, quoteIdentifier } from './dialect';

const DEFAULT_SCHEMA = 'public';

export async function readPgTableDump(read: PgRowReader, table: TableRef): Promise<TableDump> {
  const schema = table.schema ?? DEFAULT_SCHEMA;
  const rows = await read(
    `SELECT c.oid::text, c.relpersistence::text, obj_description(c.oid, 'pg_class'),
            CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p')`,
    [schema, table.name],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new DbError('not-found', `${schema}.${table.name} does not exist`);
  }
  const oid = text(row[0]);
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(table.name)}`;

  const before: string[] = [];
  const ownedBy: string[] = [];
  const owns: ObjectRef[] = [];
  for (const sequence of await ownedSequences(read, oid)) {
    const [create, owner] = await sequenceDefinition(read, sequence.schema, sequence.name);
    if (create !== undefined) {
      before.push(create);
    }
    if (owner !== undefined) {
      ownedBy.push(owner);
    }
    owns.push({ kind: 'sequence', schema: sequence.schema, name: sequence.name });
  }

  const unlogged = text(row[1]) === 'u' ? 'UNLOGGED ' : '';
  const partition = optionalText(row[3]);
  const lines = [...(await columnLines(read, oid)), ...(await constraintLines(read, oid, false))];
  const create = [
    `CREATE ${unlogged}TABLE ${qualified} (\n${lines.map((line) => `  ${line}`).join(',\n')}\n)` +
      (partition === undefined ? '' : ` PARTITION BY ${partition}`),
    ...ownedBy,
    ...(await indexStatements(read, oid)),
  ];
  const comment = optionalText(row[2]);
  if (comment !== undefined) {
    create.push(`COMMENT ON TABLE ${qualified} IS ${literal(comment)}`);
  }
  create.push(...(await columnComments(read, oid, qualified)));

  const after = [...(await foreignKeys(read, oid, qualified)), ...(await tableTriggers(read, oid))];
  return { before, create, after, owns };
}

/** Sequences a serial column of the table owns; identity columns make their own. */
async function ownedSequences(
  read: PgRowReader,
  oid: string,
): Promise<{ schema: string; name: string }[]> {
  const rows = await read(
    `SELECT sn.nspname, s.relname
     FROM pg_depend d
     JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
     JOIN pg_namespace sn ON sn.oid = s.relnamespace
     WHERE d.classid = 'pg_class'::regclass AND d.refclassid = 'pg_class'::regclass
       AND d.refobjid = $1::oid AND d.deptype = 'a'
     ORDER BY s.relname`,
    [oid],
  );
  return rows.map((row) => ({ schema: text(row[0]), name: text(row[1]) }));
}

async function foreignKeys(read: PgRowReader, oid: string, qualified: string): Promise<string[]> {
  const rows = await read(
    `SELECT conname, pg_get_constraintdef(oid, true)
     FROM pg_constraint
     WHERE conrelid = $1::oid AND contype = 'f'
     ORDER BY conname`,
    [oid],
  );
  return rows.map(
    (row) =>
      `ALTER TABLE ${qualified} ADD CONSTRAINT ${quoteIdentifier(text(row[0]))} ${text(row[1])}`,
  );
}

/**
 * Enums and domains of a schema, or only those the named tables use (arrays of them
 * included), enums first because a domain may be built on one. Types that belong to
 * an extension come with the extension and are left out.
 */
export async function readPgTypeDumps(
  read: PgRowReader,
  schemaName: string | undefined,
  tables?: readonly string[],
): Promise<TypeDump[]> {
  const schema = schemaName ?? DEFAULT_SCHEMA;
  const rows = await read(
    `SELECT t.typname, t.typtype::text,
            (SELECT string_agg(quote_literal(e.enumlabel), ', ' ORDER BY e.enumsortorder)
             FROM pg_enum e WHERE e.enumtypid = t.oid),
            format_type(t.typbasetype, t.typtypmod), t.typnotnull, t.typdefault,
            (SELECT string_agg(pg_get_constraintdef(con.oid, true), ' ' ORDER BY con.conname)
             FROM pg_constraint con WHERE con.contypid = t.oid AND con.contype = 'c')
     FROM pg_type t
     JOIN pg_namespace n ON n.oid = t.typnamespace
     WHERE n.nspname = $1 AND t.typtype IN ('e', 'd')
       AND NOT EXISTS (SELECT 1 FROM pg_depend dep
                       WHERE dep.classid = 'pg_type'::regclass AND dep.objid = t.oid
                         AND dep.deptype = 'e')
       AND ($2::text[] IS NULL OR t.oid IN (
             SELECT a.atttypid FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
             WHERE c.relnamespace = n.oid AND c.relname = ANY($2::text[])
               AND a.attnum > 0 AND NOT a.attisdropped
             UNION
             SELECT et.typelem FROM pg_attribute a
             JOIN pg_class c ON c.oid = a.attrelid
             JOIN pg_type et ON et.oid = a.atttypid
             WHERE c.relnamespace = n.oid AND c.relname = ANY($2::text[])
               AND a.attnum > 0 AND NOT a.attisdropped))
     ORDER BY t.typtype DESC, t.typname`,
    [schema, tables === undefined ? null : [...tables]],
  );
  return rows.map((row) => {
    const name = text(row[0]);
    const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
    if (text(row[1]) === 'e') {
      return {
        name,
        create: `CREATE TYPE ${qualified} AS ENUM (${text(row[2])})`,
        drop: `DROP TYPE IF EXISTS ${qualified}`,
      };
    }
    const fallback = optionalText(row[5]);
    const checks = optionalText(row[6]);
    return {
      name,
      create:
        `CREATE DOMAIN ${qualified} AS ${text(row[3])}` +
        (fallback === undefined ? '' : ` DEFAULT ${fallback}`) +
        (row[4] === true ? ' NOT NULL' : '') +
        (checks === undefined ? '' : ` ${checks}`),
      drop: `DROP DOMAIN IF EXISTS ${qualified}`,
    };
  });
}
