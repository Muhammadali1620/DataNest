// SQL Server keeps the text of views, routines and triggers (OBJECT_DEFINITION), but not
// of tables: a table's definition is put together from the catalogs here, the way the
// server's own scripting writes it, with every name quoted and qualified.

import { DbError } from '../../core/errors';
import type { ObjectRef, TableRef } from '../../core/model/objects';
import type { MetadataReader } from '../driver';
import {
  DESCRIPTION,
  flag,
  type MssqlRowReader,
  objectName,
  optionalText,
  schemaOf,
  text,
  TYPE_TEXT,
} from './catalog';
import { quoteIdentifier, quoteString, quoteTable } from './quote';

export async function readMssqlDefinition(
  read: MssqlRowReader,
  object: ObjectRef,
  reader: Pick<MetadataReader, 'listForeignKeys'>,
): Promise<string[]> {
  switch (object.kind) {
    case 'table': {
      const parts = await tableParts(read, object, reader);
      return [...parts.create, ...parts.keys, ...parts.triggers];
    }
    case 'view':
    case 'function':
    case 'procedure':
    case 'trigger':
      return [await moduleDefinition(read, object)];
    case 'sequence':
      return [await sequenceDefinition(read, object)];
    case 'event':
      throw new DbError('unsupported', 'SQL Server keeps scheduled jobs outside the database');
  }
}

/** A table in the pieces a definition and a dump place differently. */
export interface TableParts {
  /** CREATE TABLE (without foreign keys), its indexes and descriptions. */
  readonly create: string[];
  /** ALTER TABLE … ADD CONSTRAINT … FOREIGN KEY, one per key. */
  readonly keys: string[];
  readonly triggers: string[];
  readonly triggerNames: string[];
}

export async function tableParts(
  read: MssqlRowReader,
  table: TableRef,
  reader: Pick<MetadataReader, 'listForeignKeys'>,
): Promise<TableParts> {
  const ref = { schema: schemaOf(table), name: table.name };
  const qualified = quoteTable(ref);
  const [exists] = await read("SELECT OBJECT_ID(@p1, N'U')", [objectName(table)]);
  if (exists?.[0] === null || exists?.[0] === undefined) {
    throw new DbError('not-found', `${ref.schema}.${ref.name} does not exist`);
  }
  const lines = [
    ...(await columnLines(read, table)),
    ...(await keyConstraintLines(read, table)),
    ...(await checkLines(read, table)),
  ];
  const create = [
    `CREATE TABLE ${qualified} (\n${lines.map((line) => `  ${line}`).join(',\n')}\n)`,
    ...(await indexStatements(read, table, qualified)),
    ...(await descriptionStatements(read, ref)),
  ];
  // Names the server made up (FK__orders__custo__3B75D760) are left for it to make up again.
  const systemNamed = new Set(
    (
      await read(
        'SELECT name FROM sys.foreign_keys WHERE parent_object_id = OBJECT_ID(@p1) AND is_system_named = 1',
        [objectName(table)],
      )
    ).map((row) => text(row[0])),
  );
  const keys = (await reader.listForeignKeys(table)).map((key) => {
    const actions = [
      ...(key.onDelete === undefined || key.onDelete === 'NO ACTION'
        ? []
        : [`ON DELETE ${key.onDelete}`]),
      ...(key.onUpdate === undefined || key.onUpdate === 'NO ACTION'
        ? []
        : [`ON UPDATE ${key.onUpdate}`]),
    ];
    return [
      `ALTER TABLE ${qualified} ADD ${named(key.name, !systemNamed.has(key.name))}FOREIGN KEY (${key.columns.map(quoteIdentifier).join(', ')})`,
      `REFERENCES ${quoteTable({ schema: key.target.schema ?? ref.schema, name: key.target.name })} (${key.targetColumns.map(quoteIdentifier).join(', ')})`,
      ...actions,
    ].join(' ');
  });
  const triggerRows = await read(
    `SELECT tr.name, OBJECT_DEFINITION(tr.object_id)
     FROM sys.triggers tr WHERE tr.parent_id = OBJECT_ID(@p1) ORDER BY tr.name`,
    [objectName(table)],
  );
  const triggers: string[] = [];
  for (const row of triggerRows) {
    const definition = optionalText(row[1]);
    if (definition === undefined) {
      throw new DbError('permission-denied', `The definition of trigger ${text(row[0])} is hidden`);
    }
    triggers.push(withoutSemicolon(definition));
  }
  return { create, keys, triggers, triggerNames: triggerRows.map((row) => text(row[0])) };
}

async function columnLines(read: MssqlRowReader, table: TableRef): Promise<string[]> {
  const rows = await read(
    `SELECT c.name, ${TYPE_TEXT}, c.is_nullable, c.is_identity,
            CAST(ic.seed_value AS varchar(40)), CAST(ic.increment_value AS varchar(40)),
            cc.definition, cc.is_persisted,
            CASE WHEN dc.is_system_named = 0 THEN dc.name END, dc.definition, c.collation_name,
            CAST(DATABASEPROPERTYEX(DB_NAME(), 'Collation') AS nvarchar(128)), c.is_rowguidcol
     FROM sys.columns c
     JOIN sys.types t ON t.user_type_id = c.user_type_id
     LEFT JOIN sys.identity_columns ic ON ic.object_id = c.object_id AND ic.column_id = c.column_id
     LEFT JOIN sys.computed_columns cc ON cc.object_id = c.object_id AND cc.column_id = c.column_id
     LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
     WHERE c.object_id = OBJECT_ID(@p1)
     ORDER BY c.column_id`,
    [objectName(table)],
  );
  return rows.map((row) => {
    const name = quoteIdentifier(text(row[0]));
    const computed = optionalText(row[6]);
    if (computed !== undefined) {
      return `${name} AS ${computed}${flag(row[7]) ? ' PERSISTED' : ''}`;
    }
    const pieces = [name, text(row[1])];
    const collation = optionalText(row[10]);
    // Only a collation other than the database's says something about the column.
    if (collation !== undefined && collation !== optionalText(row[11])) {
      pieces.push(`COLLATE ${collation}`);
    }
    if (flag(row[3])) {
      pieces.push(`IDENTITY(${text(row[4]) || '1'}, ${text(row[5]) || '1'})`);
    }
    if (flag(row[12])) {
      pieces.push('ROWGUIDCOL');
    }
    pieces.push(flag(row[2]) ? 'NULL' : 'NOT NULL');
    const defaultName = optionalText(row[8]);
    const defaultValue = optionalText(row[9]);
    if (defaultValue !== undefined) {
      pieces.push(
        `${defaultName === undefined ? '' : `CONSTRAINT ${quoteIdentifier(defaultName)} `}DEFAULT ${defaultValue}`,
      );
    }
    return pieces.join(' ');
  });
}

/** PRIMARY KEY and UNIQUE constraints with the index kind behind them. */
async function keyConstraintLines(read: MssqlRowReader, table: TableRef): Promise<string[]> {
  const rows = await read(
    `SELECT kc.name, kc.type, i.type_desc, c.name, ic.is_descending_key, kc.is_system_named
     FROM sys.key_constraints kc
     JOIN sys.indexes i ON i.object_id = kc.parent_object_id AND i.index_id = kc.unique_index_id
     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE kc.parent_object_id = OBJECT_ID(@p1) AND ic.is_included_column = 0
     ORDER BY CASE WHEN kc.type = 'PK' THEN 0 ELSE 1 END, kc.name, ic.key_ordinal`,
    [objectName(table)],
  );
  const constraints = new Map<string, { kind: string; named: boolean; columns: string[] }>();
  for (const row of rows) {
    const name = text(row[0]);
    let entry = constraints.get(name);
    if (entry === undefined) {
      const kind = `${text(row[1]).trim() === 'PK' ? 'PRIMARY KEY' : 'UNIQUE'} ${text(row[2])}`;
      entry = { kind, named: !flag(row[5]), columns: [] };
      constraints.set(name, entry);
    }
    entry.columns.push(`${quoteIdentifier(text(row[3]))}${flag(row[4]) ? ' DESC' : ''}`);
  }
  return [...constraints.entries()].map(
    ([name, entry]) => `${named(name, entry.named)}${entry.kind} (${entry.columns.join(', ')})`,
  );
}

async function checkLines(read: MssqlRowReader, table: TableRef): Promise<string[]> {
  const rows = await read(
    `SELECT name, definition, is_system_named FROM sys.check_constraints
     WHERE parent_object_id = OBJECT_ID(@p1) ORDER BY name`,
    [objectName(table)],
  );
  return rows.map((row) => `${named(text(row[0]), !flag(row[2]))}CHECK ${text(row[1])}`);
}

/** Indexes that no constraint owns: CREATE … INDEX with included columns and filters. */
async function indexStatements(
  read: MssqlRowReader,
  table: TableRef,
  qualified: string,
): Promise<string[]> {
  const rows = await read(
    `SELECT i.name, i.is_unique, i.type_desc, i.filter_definition, c.name,
            ic.is_descending_key, ic.is_included_column, i.type
     FROM sys.indexes i
     JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
     JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
     WHERE i.object_id = OBJECT_ID(@p1) AND i.is_primary_key = 0 AND i.is_unique_constraint = 0
       AND i.type IN (1, 2, 5, 6) AND i.is_hypothetical = 0
     ORDER BY i.name, ic.is_included_column,
              CASE WHEN ic.key_ordinal = 0 THEN ic.index_column_id ELSE ic.key_ordinal END`,
    [objectName(table)],
  );
  const indexes = new Map<
    string,
    { head: string; keys: string[]; included: string[]; where?: string; columnstore: boolean }
  >();
  for (const row of rows) {
    const name = text(row[0]);
    let entry = indexes.get(name);
    if (entry === undefined) {
      const type = Number(row[7]);
      const columnstore = type === 5 || type === 6;
      const kind = text(row[2]).replace(/ COLUMNSTORE$/u, '');
      const where = optionalText(row[3]);
      entry = {
        head: `CREATE ${flag(row[1]) ? 'UNIQUE ' : ''}${kind}${columnstore ? ' COLUMNSTORE' : ''} INDEX ${quoteIdentifier(name)} ON ${qualified}`,
        keys: [],
        included: [],
        columnstore,
        ...(where === undefined ? {} : { where }),
      };
      indexes.set(name, entry);
    }
    const column = quoteIdentifier(text(row[4]));
    if (flag(row[6]) && !entry.columnstore) {
      entry.included.push(column);
    } else {
      entry.keys.push(`${column}${flag(row[5]) ? ' DESC' : ''}`);
    }
  }
  return [...indexes.values()].map((entry) => {
    // A clustered columnstore index covers the whole table and names no columns.
    const keys =
      entry.columnstore && entry.head.startsWith('CREATE CLUSTERED')
        ? ''
        : ` (${entry.keys.join(', ')})`;
    const include = entry.included.length === 0 ? '' : ` INCLUDE (${entry.included.join(', ')})`;
    return `${entry.head}${keys}${include}${entry.where === undefined ? '' : ` WHERE ${entry.where}`}`;
  });
}

/** The descriptions of a table and its columns, as `sp_addextendedproperty` calls. */
async function descriptionStatements(
  read: MssqlRowReader,
  table: { schema: string; name: string },
): Promise<string[]> {
  const rows = await read(
    `SELECT c.name, CAST(ep.value AS nvarchar(max))
     FROM sys.extended_properties ep
     LEFT JOIN sys.columns c ON c.object_id = ep.major_id AND c.column_id = ep.minor_id
     WHERE ep.class = 1 AND ep.major_id = OBJECT_ID(@p1) AND ep.name = @p2
     ORDER BY ep.minor_id`,
    [objectName(table), DESCRIPTION],
  );
  return rows.map((row) => describeSql(table, optionalText(row[0]), text(row[1])));
}

/** `EXEC sp_addextendedproperty` of a table's or a column's description. */
export function describeSql(
  table: { schema: string; name: string },
  column: string | undefined,
  description: string,
  procedure = 'sp_addextendedproperty',
): string {
  const target = [
    `N'SCHEMA', ${quoteString(table.schema)}`,
    `N'TABLE', ${quoteString(table.name)}`,
    ...(column === undefined ? [] : [`N'COLUMN', ${quoteString(column)}`]),
  ];
  const value = procedure === 'sp_dropextendedproperty' ? '' : `, ${quoteString(description)}`;
  return `EXEC ${procedure} ${quoteString(DESCRIPTION)}${value}, ${target.join(', ')}`;
}

/** Views, routines and triggers exactly as they were created. */
async function moduleDefinition(read: MssqlRowReader, object: ObjectRef): Promise<string> {
  const [row] = await read(
    `SELECT o.object_id, OBJECT_DEFINITION(o.object_id) FROM sys.objects o
     WHERE o.object_id = OBJECT_ID(@p1)`,
    [quoteTable({ schema: schemaOf(object), name: object.name })],
  );
  if (row === undefined) {
    throw new DbError('not-found', `${schemaOf(object)}.${object.name} does not exist`);
  }
  const definition = optionalText(row[1]);
  if (definition === undefined) {
    // Encrypted (WITH ENCRYPTION), or VIEW DEFINITION is not granted.
    throw new DbError(
      'permission-denied',
      `The server does not show the definition of ${object.name}`,
    );
  }
  return withoutSemicolon(definition);
}

async function sequenceDefinition(read: MssqlRowReader, object: ObjectRef): Promise<string> {
  const [row] = await read(
    `SELECT TYPE_NAME(s.user_type_id), CAST(s.start_value AS varchar(40)),
            CAST(s.increment AS varchar(40)), CAST(s.minimum_value AS varchar(40)),
            CAST(s.maximum_value AS varchar(40)), s.is_cycling, s.is_cached,
            s.cache_size, s.precision, s.scale
     FROM sys.sequences s WHERE s.object_id = OBJECT_ID(@p1)`,
    [quoteTable({ schema: schemaOf(object), name: object.name })],
  );
  if (row === undefined) {
    throw new DbError('not-found', `${schemaOf(object)}.${object.name} does not exist`);
  }
  const type = text(row[0]);
  const typed =
    type === 'decimal' || type === 'numeric' ? `${type}(${text(row[8])}, ${text(row[9])})` : type;
  const cache = flag(row[6])
    ? row[7] === null || row[7] === undefined
      ? 'CACHE'
      : `CACHE ${text(row[7])}`
    : 'NO CACHE';
  return [
    `CREATE SEQUENCE ${quoteTable({ schema: schemaOf(object), name: object.name })} AS ${typed}`,
    `START WITH ${text(row[1])}`,
    `INCREMENT BY ${text(row[2])}`,
    `MINVALUE ${text(row[3])}`,
    `MAXVALUE ${text(row[4])}`,
    flag(row[5]) ? 'CYCLE' : 'NO CYCLE',
    cache,
  ].join(' ');
}

/** `CONSTRAINT [name] ` for a name the user chose, nothing for one the server made up. */
function named(name: string, chosen: boolean): string {
  return chosen ? `CONSTRAINT ${quoteIdentifier(name)} ` : '';
}

function withoutSemicolon(sql: string): string {
  return sql.replace(/;\s*$/u, '').trim();
}
