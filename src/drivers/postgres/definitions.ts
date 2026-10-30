// PostgreSQL has no SHOW CREATE TABLE, so a table's definition is put together
// from the catalogs; the server prints every piece it can itself (types, defaults,
// constraints, indexes, triggers), so only the frame around them is ours.

import { DbError } from '../../core/errors';
import type { ObjectRef } from '../../core/model/objects';
import { literal, quoteIdentifier } from './dialect';
import { generatedColumnSql, type PgServer, printsTriggers, withoutDatabase } from './server';
import { msg } from '../../core/user-message';

/**
 * Runs one catalog query and returns its rows as arrays; `server` says which catalogs it
 * reads (V6.5), a current PostgreSQL when absent.
 */
export type PgRowReader = ((sql: string, params?: unknown[]) => Promise<unknown[][]>) & {
  readonly server?: PgServer;
};

const DEFAULT_SCHEMA = 'public';

export async function readPgDefinition(read: PgRowReader, object: ObjectRef): Promise<string[]> {
  const schema = object.schema ?? DEFAULT_SCHEMA;
  switch (object.kind) {
    case 'table':
    case 'view':
      return await relationDefinition(read, schema, object.name);
    case 'function':
    case 'procedure':
      return await routineDefinition(read, schema, object);
    case 'trigger':
      return await triggerDefinition(read, schema, object);
    case 'sequence':
      return await sequenceDefinition(read, schema, object.name);
    case 'event':
      throw new DbError('unsupported', msg('PostgreSQL has no scheduled events'));
  }
}

/** Tables, views and materialized views: what `pg_class` says decides the frame. */
async function relationDefinition(
  read: PgRowReader,
  schema: string,
  name: string,
): Promise<string[]> {
  const rows = await read(
    `SELECT c.oid::text, c.relkind::text, c.relpersistence::text,
            obj_description(c.oid, 'pg_class'),
            CASE WHEN c.relkind IN ('v', 'm') THEN pg_get_viewdef(c.oid, true) END,
            CASE WHEN c.relkind = 'p' THEN pg_get_partkeydef(c.oid) END,
            current_database()
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')`,
    [schema, name],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new DbError('not-found', msg('{0}.{1} does not exist', schema, name));
  }
  const oid = text(row[0]);
  const kind = text(row[1]);
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  const statements: string[] = [];
  if (kind === 'v' || kind === 'm') {
    const printed = stripSemicolon(text(row[4]).trim());
    const body =
      read.server?.flavor === 'cockroach' ? withoutDatabase(printed, text(row[6])) : printed;
    statements.push(
      kind === 'v'
        ? `CREATE OR REPLACE VIEW ${qualified} AS\n${body}`
        : `CREATE MATERIALIZED VIEW ${qualified} AS\n${body}`,
    );
  } else {
    const unlogged = text(row[2]) === 'u' ? 'UNLOGGED ' : '';
    const partition = optionalText(row[5]);
    const lines = [...(await columnLines(read, oid)), ...(await constraintLines(read, oid))];
    statements.push(
      `CREATE ${unlogged}TABLE ${qualified} (\n${lines.map((line) => `  ${line}`).join(',\n')}\n)` +
        (partition === undefined ? '' : ` PARTITION BY ${partition}`),
    );
  }
  if (kind !== 'v') {
    statements.push(...(await indexStatements(read, oid)));
  }
  const comment = optionalText(row[3]);
  const target = kind === 'v' ? 'VIEW' : kind === 'm' ? 'MATERIALIZED VIEW' : 'TABLE';
  if (comment !== undefined) {
    statements.push(`COMMENT ON ${target} ${qualified} IS ${literal(comment)}`);
  }
  statements.push(...(await columnComments(read, oid, qualified)));
  statements.push(...(await tableTriggers(read, oid)));
  return statements;
}

export async function columnLines(read: PgRowReader, oid: string): Promise<string[]> {
  const rows = await read(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
            pg_get_expr(d.adbin, d.adrelid), a.attidentity::text, ${generatedColumnSql(read.server)},
            CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation
              THEN (SELECT quote_ident(cn.nspname) || '.' || quote_ident(co.collname)
                    FROM pg_collation co JOIN pg_namespace cn ON cn.oid = co.collnamespace
                    WHERE co.oid = a.attcollation) END
     FROM pg_attribute a
     JOIN pg_type t ON t.oid = a.atttypid
     LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
     WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY a.attnum`,
    [oid],
  );
  return rows.map((row) => {
    const expression = optionalText(row[3]);
    const identity = text(row[4]);
    const generated = text(row[5]);
    const collation = optionalText(row[6]);
    let line = `${quoteIdentifier(text(row[0]))} ${text(row[1])}`;
    if (collation !== undefined) {
      line += ` COLLATE ${collation}`;
    }
    if (identity === 'a' || identity === 'd') {
      line +=
        identity === 'a' ? ' GENERATED ALWAYS AS IDENTITY' : ' GENERATED BY DEFAULT AS IDENTITY';
    } else if ((generated === 's' || generated === 'v') && expression !== undefined) {
      line += ` GENERATED ALWAYS AS (${expression}) ${generated === 's' ? 'STORED' : 'VIRTUAL'}`;
    } else if (expression !== undefined) {
      line += ` DEFAULT ${expression}`;
    }
    if (row[2] === true) {
      line += ' NOT NULL';
    }
    return line;
  });
}

/** Constraint lines of CREATE TABLE; foreign keys only when `foreignKeys` is set. */
export async function constraintLines(
  read: PgRowReader,
  oid: string,
  foreignKeys = true,
): Promise<string[]> {
  const rows = await read(
    `SELECT conname, pg_get_constraintdef(oid, true)
     FROM pg_constraint
     WHERE conrelid = $1::oid AND contype IN ('p', 'u', 'c', 'x', ${foreignKeys ? "'f'" : "'p'"})
     ORDER BY CASE contype WHEN 'p' THEN 0 WHEN 'u' THEN 1 WHEN 'c' THEN 2 WHEN 'f' THEN 3
              ELSE 4 END, conname`,
    [oid],
  );
  return rows.map((row) => `CONSTRAINT ${quoteIdentifier(text(row[0]))} ${text(row[1])}`);
}

/** Indexes of their own; the ones behind a key are already part of the constraint. */
export async function indexStatements(read: PgRowReader, oid: string): Promise<string[]> {
  const rows = await read(
    `SELECT pg_get_indexdef(i.indexrelid), current_database()
     FROM pg_index i
     JOIN pg_class ic ON ic.oid = i.indexrelid
     WHERE i.indrelid = $1::oid
       AND NOT EXISTS (SELECT 1 FROM pg_constraint con
                       WHERE con.conindid = i.indexrelid AND con.contype IN ('p', 'u', 'x'))
     ORDER BY ic.relname`,
    [oid],
  );
  // CockroachDB names the table with its database in front, as it does in views.
  return rows.map((row) =>
    read.server?.flavor === 'cockroach'
      ? withoutDatabase(text(row[0]), text(row[1]))
      : text(row[0]),
  );
}

export async function columnComments(
  read: PgRowReader,
  oid: string,
  qualified: string,
): Promise<string[]> {
  const rows = await read(
    `SELECT a.attname, col_description(a.attrelid, a.attnum)
     FROM pg_attribute a
     WHERE a.attrelid = $1::oid AND a.attnum > 0 AND NOT a.attisdropped
       AND col_description(a.attrelid, a.attnum) IS NOT NULL
     ORDER BY a.attnum`,
    [oid],
  );
  return rows.map(
    (row) =>
      `COMMENT ON COLUMN ${qualified}.${quoteIdentifier(text(row[0]))} IS ${literal(text(row[1]))}`,
  );
}

export async function tableTriggers(read: PgRowReader, oid: string): Promise<string[]> {
  if (!printsTriggers(read.server)) {
    return [];
  }
  const rows = await read(
    `SELECT pg_get_triggerdef(oid, true) FROM pg_trigger
     WHERE tgrelid = $1::oid AND NOT tgisinternal ORDER BY tgname`,
    [oid],
  );
  return rows.map((row) => text(row[0]));
}

/**
 * Functions and procedures. Without a signature every overload of the name is
 * returned; aggregates and window functions have no `pg_get_functiondef`.
 */
async function routineDefinition(
  read: PgRowReader,
  schema: string,
  object: ObjectRef,
): Promise<string[]> {
  const rows = await read(
    `SELECT pg_get_functiondef(p.oid), obj_description(p.oid, 'pg_proc'),
            pg_get_function_identity_arguments(p.oid)
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = $1 AND p.proname = $2 AND p.prokind = $3
       AND ($4::text IS NULL OR pg_get_function_identity_arguments(p.oid) = $4)
     ORDER BY pg_get_function_identity_arguments(p.oid)`,
    [schema, object.name, object.kind === 'procedure' ? 'p' : 'f', object.signature ?? null],
  );
  if (rows.length === 0) {
    throw new DbError('not-found', msg('{0}.{1} does not exist', schema, object.name));
  }
  const statements: string[] = [];
  const keyword = object.kind === 'procedure' ? 'PROCEDURE' : 'FUNCTION';
  for (const row of rows) {
    statements.push(text(row[0]).trim());
    const comment = optionalText(row[1]);
    if (comment !== undefined) {
      statements.push(
        `COMMENT ON ${keyword} ${quoteIdentifier(schema)}.${quoteIdentifier(object.name)}(${text(row[2])}) IS ${literal(comment)}`,
      );
    }
  }
  return statements;
}

async function triggerDefinition(
  read: PgRowReader,
  schema: string,
  object: ObjectRef,
): Promise<string[]> {
  if (!printsTriggers(read.server)) {
    throw new DbError('unsupported', msg('CockroachDB cannot print a trigger back as SQL'));
  }
  const rows = await read(
    `SELECT pg_get_triggerdef(t.oid, true)
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND t.tgname = $2 AND NOT t.tgisinternal
       AND ($3::text IS NULL OR c.relname = $3)
     ORDER BY c.relname`,
    [schema, object.name, object.table ?? null],
  );
  if (rows.length === 0) {
    throw new DbError('not-found', msg('{0}.{1} does not exist', schema, object.name));
  }
  return rows.map((row) => text(row[0]));
}

export async function sequenceDefinition(
  read: PgRowReader,
  schema: string,
  name: string,
): Promise<string[]> {
  const rows = await read(
    `SELECT format_type(s.seqtypid, NULL), s.seqincrement::text, s.seqmin::text,
            s.seqmax::text, s.seqstart::text, s.seqcache::text, s.seqcycle,
            (SELECT quote_ident(tn.nspname) || '.' || quote_ident(tc.relname) || '.' ||
                    quote_ident(a.attname)
             FROM pg_depend d
             JOIN pg_class tc ON tc.oid = d.refobjid
             JOIN pg_namespace tn ON tn.oid = tc.relnamespace
             JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid AND d.deptype = 'a'
             LIMIT 1)
     FROM pg_sequence s
     JOIN pg_class c ON c.oid = s.seqrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2`,
    [schema, name],
  );
  const row = rows[0];
  if (row === undefined) {
    throw new DbError('not-found', msg('{0}.{1} does not exist', schema, name));
  }
  const qualified = `${quoteIdentifier(schema)}.${quoteIdentifier(name)}`;
  const statements = [
    [
      `CREATE SEQUENCE ${qualified}`,
      `  AS ${text(row[0])}`,
      `  INCREMENT BY ${text(row[1])}`,
      `  MINVALUE ${text(row[2])}`,
      `  MAXVALUE ${text(row[3])}`,
      `  START WITH ${text(row[4])}`,
      `  CACHE ${text(row[5])}`,
      row[6] === true ? '  CYCLE' : '  NO CYCLE',
    ].join('\n'),
  ];
  const owner = optionalText(row[7]);
  if (owner !== undefined) {
    statements.push(`ALTER SEQUENCE ${qualified} OWNED BY ${owner}`);
  }
  return statements;
}

/** pg_get_viewdef ends its text with a semicolon; statements here never do. */
function stripSemicolon(sql: string): string {
  return sql.endsWith(';') ? sql.slice(0, -1).trimEnd() : sql;
}

export function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}
