// What the tree and completion read from Cassandra: keyspaces (the "databases"), tables and
// materialized views, the columns of each with the roles they play in the key, and the secondary
// indexes. Everything comes from `system_schema` with parameters; nothing is built from user text.

import { DbError } from '../../core/errors';
import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectInfo,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
  TableStructure,
} from '../../core/model/objects';
import { msg } from '../../core/user-message';
import type { CellValue } from '../../shared/cell-value';
import type { MetadataReader, TableDump, TypeDump } from '../driver';
import { quoteIdentifier, quoteString, quoteTable } from './dialect';

/** What the session offers its metadata reader. */
export interface CqlReader {
  queryRows(cql: string, parameters?: readonly unknown[]): Promise<CellValue[][]>;
}

function text(cell: CellValue | undefined): string {
  return typeof cell === 'string' ? cell : '';
}

function count(cell: CellValue | undefined): number {
  return typeof cell === 'number' ? cell : 0;
}

/** A map cell comes as JSON text (`{"target":"name"}`); its string members. */
function mapOf(cell: CellValue | undefined): Record<string, string> {
  if (typeof cell !== 'object' || cell === null || !('text' in cell)) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(cell.text);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    );
  } catch {
    return {};
  }
}

function keyspaceOf(scope: ObjectScope): string {
  const keyspace = scope.database ?? scope.schema;
  if (keyspace === undefined || keyspace === '') {
    throw new DbError('unsupported', msg('Pick a keyspace first'));
  }
  return keyspace;
}

function refuse(reason: string): never {
  throw new DbError('unsupported', reason);
}

/** The roles of a column in the table's key, as `system_schema.columns` names them. */
type Kind = 'partition_key' | 'clustering' | 'static' | 'regular';

interface ColumnRow {
  readonly name: string;
  readonly type: string;
  readonly kind: Kind;
  readonly position: number;
  readonly descending: boolean;
}

const COLUMNS_CQL =
  'SELECT column_name, type, kind, position, clustering_order FROM system_schema.columns ' +
  'WHERE keyspace_name = ? AND table_name = ?';

function columnRows(rows: readonly CellValue[][]): ColumnRow[] {
  return rows.map((row) => ({
    name: text(row[0]),
    type: text(row[1]),
    kind: (['partition_key', 'clustering', 'static'].includes(text(row[2]))
      ? text(row[2])
      : 'regular') as Kind,
    position: count(row[3]),
    descending: text(row[4]).toLowerCase() === 'desc',
  }));
}

/** Partition key columns in key order, then clustering columns, then the rest by name. */
function inTableOrder(columns: readonly ColumnRow[]): ColumnRow[] {
  const rank = (kind: Kind): number =>
    kind === 'partition_key' ? 0 : kind === 'clustering' ? 1 : 2;
  return [...columns].sort(
    (a, b) =>
      rank(a.kind) - rank(b.kind) ||
      (rank(a.kind) < 2 ? a.position - b.position : a.name.localeCompare(b.name)),
  );
}

export class CassandraMetadata implements MetadataReader {
  constructor(private readonly session: CqlReader) {}

  async listDatabases(): Promise<string[]> {
    const rows = await this.session.queryRows('SELECT keyspace_name FROM system_schema.keyspaces');
    return rows
      .map((row) => text(row[0]))
      .filter((name) => name !== '')
      .sort((a, b) => a.localeCompare(b));
  }

  listSchemas(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async listTables(scope: ObjectScope): Promise<TableInfo[]> {
    const keyspace = keyspaceOf(scope);
    const tables = await this.session.queryRows(
      'SELECT table_name FROM system_schema.tables WHERE keyspace_name = ?',
      [keyspace],
    );
    const views = await this.session.queryRows(
      'SELECT view_name FROM system_schema.views WHERE keyspace_name = ?',
      [keyspace],
    );
    return [
      ...tables.map((row) => ({ name: text(row[0]), kind: 'table' as const })),
      ...views.map((row) => ({ name: text(row[0]), kind: 'view' as const, materialized: true })),
    ]
      .filter((entry) => entry.name !== '')
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const rows = await this.session.queryRows(COLUMNS_CQL, [keyspaceOf(table), table.name]);
    return inTableOrder(columnRows(rows)).map((column) => ({
      name: column.name,
      dataType: column.type,
      nullable: column.kind !== 'partition_key' && column.kind !== 'clustering',
      primaryKey: column.kind === 'partition_key' || column.kind === 'clustering',
    }));
  }

  /** The key is the primary key; a secondary index never makes a row unique. */
  listUniqueKeys(): Promise<string[][]> {
    return Promise.resolve([]);
  }

  listForeignKeys(): Promise<ForeignKey[]> {
    return Promise.resolve([]);
  }

  async listObjects(scope: ObjectScope, kind: ListedObjectKind): Promise<ObjectInfo[]> {
    if (kind !== 'function') {
      return [];
    }
    const rows = await this.session.queryRows(
      'SELECT function_name, argument_types FROM system_schema.functions WHERE keyspace_name = ?',
      [keyspaceOf(scope)],
    );
    return rows
      .map((row) => {
        const types = mapTypes(row[1]);
        return {
          name: text(row[0]),
          kind: 'function' as const,
          ...(types === '' ? {} : { signature: types }),
        };
      })
      .filter((entry) => entry.name !== '')
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listIndexes(table: TableRef): Promise<IndexInfo[]> {
    const keyspace = keyspaceOf(table);
    const columns = inTableOrder(
      columnRows(await this.session.queryRows(COLUMNS_CQL, [keyspace, table.name])),
    ).filter((column) => column.kind === 'partition_key' || column.kind === 'clustering');
    const primary: IndexInfo[] =
      columns.length === 0
        ? []
        : [
            {
              name: 'PRIMARY KEY',
              columns: columns.map((column) => column.name),
              unique: true,
              primary: true,
            },
          ];
    const rows = await this.session.queryRows(
      'SELECT index_name, kind, options FROM system_schema.indexes ' +
        'WHERE keyspace_name = ? AND table_name = ?',
      [keyspace, table.name],
    );
    const secondary = rows
      .map<IndexInfo>((row) => {
        const options = mapOf(row[2]);
        return {
          name: text(row[0]),
          columns: [options.target ?? ''].filter((target) => target !== ''),
          unique: false,
          primary: false,
          method: text(row[1]),
        };
      })
      .filter((index) => index.name !== '')
      .sort((a, b) => a.name.localeCompare(b.name));
    return [...primary, ...secondary];
  }

  describeTable(): Promise<TableStructure> {
    return Promise.reject(
      new DbError(
        'unsupported',
        msg(
          'Cassandra has no table designer: a table is its key, so change it with CQL (CREATE TABLE, ALTER TABLE)',
        ),
      ),
    );
  }

  /** The CQL that creates a table or a materialized view as it is now, with its indexes. */
  async getDefinition(object: ObjectRef): Promise<string[]> {
    if (object.kind === 'function') {
      return await this.functionDefinition(object);
    }
    if (object.kind !== 'table' && object.kind !== 'view') {
      return refuse(msg('Cassandra keeps no such objects'));
    }
    const keyspace = keyspaceOf(object);
    const columns = inTableOrder(
      columnRows(await this.session.queryRows(COLUMNS_CQL, [keyspace, object.name])),
    );
    if (columns.length === 0) {
      throw new DbError('not-found', msg('"{0}" does not exist', object.name));
    }
    const target = quoteTable({ database: keyspace, name: object.name });
    const partition = columns.filter((column) => column.kind === 'partition_key');
    const clustering = columns.filter((column) => column.kind === 'clustering');
    const names = (list: readonly ColumnRow[]): string =>
      list.map((column) => quoteIdentifier(column.name)).join(', ');
    const key = `PRIMARY KEY ((${names(partition)})${clustering.length === 0 ? '' : `, ${names(clustering)}`})`;
    const order =
      clustering.length === 0
        ? ''
        : ` WITH CLUSTERING ORDER BY (${clustering
            .map(
              (column) => `${quoteIdentifier(column.name)} ${column.descending ? 'DESC' : 'ASC'}`,
            )
            .join(', ')})`;
    if (object.kind === 'view') {
      const view = await this.session.queryRows(
        'SELECT base_table_name, where_clause FROM system_schema.views ' +
          'WHERE keyspace_name = ? AND view_name = ?',
        [keyspace, object.name],
      );
      const base = quoteTable({ database: keyspace, name: text(view[0]?.[0]) });
      const where = text(view[0]?.[1]);
      return [
        `CREATE MATERIALIZED VIEW ${target} AS SELECT ${names(columns)} FROM ${base}` +
          (where === '' ? '' : ` WHERE ${where}`) +
          ` ${key}${order}`,
      ];
    }
    const statics = new Set(
      columns.filter((column) => column.kind === 'static').map((c) => c.name),
    );
    const definitions = columns.map(
      (column) =>
        `${quoteIdentifier(column.name)} ${column.type}${statics.has(column.name) ? ' STATIC' : ''}`,
    );
    const create = `CREATE TABLE ${target} (${[...definitions, key].join(', ')})${order}`;
    const indexes = await this.session.queryRows(
      'SELECT index_name, kind, options FROM system_schema.indexes ' +
        'WHERE keyspace_name = ? AND table_name = ?',
      [keyspace, object.name],
    );
    const statements = indexes
      .map((row) => {
        const options = mapOf(row[2]);
        const column = options.target ?? '';
        if (column === '') {
          return '';
        }
        const custom =
          text(row[1]) === 'CUSTOM' && options.class_name !== undefined
            ? ` USING ${quoteString(options.class_name)}`
            : '';
        return `CREATE ${custom === '' ? '' : 'CUSTOM '}INDEX ${quoteIdentifier(text(row[0]))} ON ${target} (${column})${custom}`;
      })
      .filter((statement) => statement !== '');
    return [create, ...statements];
  }

  private async functionDefinition(object: ObjectRef): Promise<string[]> {
    const rows = await this.session.queryRows(
      'SELECT argument_names, argument_types, return_type, language, body FROM system_schema.functions ' +
        'WHERE keyspace_name = ? AND function_name = ?',
      [keyspaceOf(object), object.name],
    );
    const row = rows[0];
    if (row === undefined) {
      throw new DbError('not-found', msg('"{0}" does not exist', object.name));
    }
    const names = listOf(row[0]);
    const types = listOf(row[1]);
    const args = names.map((name, index) =>
      `${quoteIdentifier(name)} ${types[index] ?? ''}`.trim(),
    );
    return [
      `CREATE OR REPLACE FUNCTION ${quoteTable({ database: keyspaceOf(object), name: object.name })}` +
        `(${args.join(', ')}) CALLED ON NULL INPUT RETURNS ${text(row[2])} ` +
        `LANGUAGE ${text(row[3])} AS $$${text(row[4])}$$`,
    ];
  }

  getTableDump(): Promise<TableDump> {
    return Promise.reject(
      new DbError(
        'unsupported',
        msg('Cassandra has no SQL dump: use cqlsh COPY, nodetool snapshot or DSBulk'),
      ),
    );
  }

  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }
}

/** A list cell comes as JSON text (`["int","text"]`); its string items. */
function listOf(cell: CellValue | undefined): string[] {
  if (typeof cell !== 'object' || cell === null || !('text' in cell)) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(cell.text);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string')
      : [];
  } catch {
    return [];
  }
}

function mapTypes(cell: CellValue | undefined): string {
  return listOf(cell).join(', ');
}
