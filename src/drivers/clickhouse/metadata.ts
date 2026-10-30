// Structure of a ClickHouse server from its `system` tables. There are no schemas, no
// unique or foreign keys and no routines of a database; a table's primary key is its
// sorting key, which does not identify a row, so it is never offered for editing.

import { DbError } from '../../core/errors';
import { isClickhouseNullable } from '../../shared/clickhouse-types';
import type {
  ColumnDetail,
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ObjectInfo,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
  TableStructure,
} from '../../core/model/objects';
import type { MetadataReader, TableDump, TypeDump } from '../driver';
import { msg } from '../../core/user-message';

/** Runs one catalog query with `{name:Type}` parameters and returns its rows. */
export type ClickhouseRowReader = (
  sql: string,
  params?: Record<string, string>,
) => Promise<unknown[][]>;

const VIEW_ENGINES = new Set(['View', 'MaterializedView', 'LiveView', 'WindowView']);

/** Kinds of column that the server computes: they are read, never written. */
const COMPUTED = new Set(['MATERIALIZED', 'ALIAS', 'EPHEMERAL']);

/** Catalog values: text as it is, numbers (UInt64 counts arrive as text anyway) as text. */
function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'bigint'
      ? String(value)
      : '';
}

function optional(value: unknown): string | undefined {
  const result = text(value);
  return result === '' ? undefined : result;
}

/** A table's database: the one it names, else the session's own. */
function databaseOf(scope: ObjectScope): string {
  return scope.database ?? '';
}

const CURRENT = "if({db:String} = '', currentDatabase(), {db:String})";

/** `a, b` of a key clause; empty when any part is an expression, not a column. */
export function keyColumns(key: string, columns: ReadonlySet<string>): string[] {
  const parts = key
    .split(',')
    .map((part) => part.trim().replace(/^`(.*)`$/u, '$1'))
    .filter((part) => part !== '');
  return parts.every((part) => columns.has(part)) ? parts : [];
}

/**
 * The name SHOW CREATE gives a table carries its database; a dump names it bare, so the
 * script lands in whichever database it is run on.
 */
export function withoutDatabase(statement: string, database: string): string {
  const quoted = `(?:\`${database.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\`|${database.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')})`;
  return statement.replace(
    new RegExp(
      `^(\\s*CREATE\\s+(?:OR\\s+REPLACE\\s+)?(?:TABLE|VIEW|MATERIALIZED\\s+VIEW|DICTIONARY)\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?)${quoted}\\.`,
      'iu',
    ),
    '$1',
  );
}

export class ClickhouseMetadata implements MetadataReader {
  constructor(private readonly read: ClickhouseRowReader) {}

  async listDatabases(): Promise<string[]> {
    const rows = await this.read('SELECT name FROM system.databases ORDER BY name');
    return rows.map((row) => text(row[0])).filter((name) => name !== '');
  }

  listSchemas(): Promise<string[]> {
    return Promise.resolve([]);
  }

  async listTables(scope: ObjectScope): Promise<TableInfo[]> {
    // The `.inner…` tables hold what materialized views store; they belong to the view.
    const rows = await this.read(
      `SELECT name, engine FROM system.tables
       WHERE database = ${CURRENT} AND NOT is_temporary AND NOT startsWith(name, '.inner')
       ORDER BY name`,
      { db: databaseOf(scope) },
    );
    return rows.map((row) => {
      const engine = text(row[1]);
      return VIEW_ENGINES.has(engine)
        ? {
            name: text(row[0]),
            kind: 'view' as const,
            ...(engine === 'MaterializedView' ? { materialized: true } : {}),
          }
        : { name: text(row[0]), kind: 'table' as const };
    });
  }

  private async columns(table: TableRef): Promise<unknown[][]> {
    return await this.read(
      `SELECT name, type, default_kind, default_expression, comment
       FROM system.columns
       WHERE database = ${CURRENT} AND table = {table:String}
       ORDER BY position`,
      { db: databaseOf(table), table: table.name },
    );
  }

  /** Rows cannot be told apart by any key here, so no column counts as one. */
  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    return (await this.columns(table)).map((row) => {
      const kind = text(row[2]);
      const expression = optional(row[3]);
      return {
        name: text(row[0]),
        dataType: text(row[1]),
        nullable: isClickhouseNullable(text(row[1])),
        primaryKey: false,
        ...(kind === 'DEFAULT' && expression !== undefined ? { defaultValue: expression } : {}),
      };
    });
  }

  listUniqueKeys(): Promise<string[][]> {
    return Promise.resolve([]);
  }

  listForeignKeys(): Promise<ForeignKey[]> {
    return Promise.resolve([]);
  }

  listObjects(): Promise<ObjectInfo[]> {
    return Promise.resolve([]);
  }

  /** The sorting key first (as the primary key), then the data skipping indexes. */
  async listIndexes(table: TableRef): Promise<IndexInfo[]> {
    const [keys] = await this.read(
      `SELECT primary_key, sorting_key FROM system.tables
       WHERE database = ${CURRENT} AND name = {table:String}`,
      { db: databaseOf(table), table: table.name },
    );
    const indexes: IndexInfo[] = [];
    const primary = text(keys?.[0]) || text(keys?.[1]);
    if (primary !== '') {
      indexes.push({
        name: 'PRIMARY KEY',
        columns: primary.split(',').map((part) => part.trim()),
        unique: false,
        primary: true,
      });
    }
    const skipping = await this.read(
      `SELECT name, expr, type FROM system.data_skipping_indices
       WHERE database = ${CURRENT} AND table = {table:String}
       ORDER BY name`,
      { db: databaseOf(table), table: table.name },
    );
    for (const row of skipping) {
      indexes.push({
        name: text(row[0]),
        columns: [text(row[1])],
        unique: false,
        primary: false,
        method: text(row[2]),
      });
    }
    return indexes;
  }

  async describeTable(table: TableRef): Promise<TableStructure> {
    const [relation] = await this.read(
      `SELECT comment, engine FROM system.tables
       WHERE database = ${CURRENT} AND name = {table:String}`,
      { db: databaseOf(table), table: table.name },
    );
    if (relation === undefined || VIEW_ENGINES.has(text(relation[1]))) {
      throw new DbError('not-found', msg('{0} does not exist', table.name));
    }
    const columns = (await this.columns(table)).map((row): ColumnDetail => {
      const type = text(row[1]);
      const kind = text(row[2]);
      const expression = optional(row[3]);
      const comment = optional(row[4]);
      // The designer keeps nullability apart from the type: Nullable(String) is a
      // nullable String. LowCardinality(Nullable(…)) stays whole: it cannot be split.
      const nullable = type.startsWith('Nullable(');
      return {
        name: text(row[0]),
        dataType: nullable ? type.replace(/^Nullable\((.*)\)$/su, '$1') : type,
        nullable,
        autoIncrement: false,
        generated: COMPUTED.has(kind),
        ...(kind === 'DEFAULT' && expression !== undefined
          ? { defaultExpression: expression }
          : {}),
        ...(comment === undefined ? {} : { comment }),
      };
    });
    const indexes = await this.listIndexes(table);
    const names = new Set(columns.map((column) => column.name));
    const primary = indexes.find((index) => index.primary);
    const comment = optional(relation[0]);
    return {
      columns,
      primaryKey: primary === undefined ? [] : keyColumns(primary.columns.join(', '), names),
      indexes,
      foreignKeys: [],
      ...(comment === undefined ? {} : { comment }),
    };
  }

  async getDefinition(object: ObjectRef): Promise<string[]> {
    switch (object.kind) {
      case 'table':
      case 'view': {
        // Without its database, so the text runs in whichever database it is opened for.
        const create = await this.showCreate(object);
        return [object.database === undefined ? create : withoutDatabase(create, object.database)];
      }
      case 'function':
      case 'procedure':
      case 'trigger':
      case 'sequence':
      case 'event':
        throw new DbError(
          'unsupported',
          msg('ClickHouse has no {0} inside a database', object.kind),
        );
    }
  }

  async getTableDump(table: TableRef): Promise<TableDump> {
    const create = await this.showCreate(table);
    const database = table.database ?? '';
    return {
      before: [],
      create: [database === '' ? create : withoutDatabase(create, database)],
      after: [],
      owns: [],
    };
  }

  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }

  /** SHOW CREATE, which formats the statement the way the server's own client does. */
  private async showCreate(table: TableRef): Promise<string> {
    const database = table.database ?? text((await this.read('SELECT currentDatabase()'))[0]?.[0]);
    const [shown] = await this.read('SHOW CREATE TABLE {db:Identifier}.{table:Identifier}', {
      db: database,
      table: table.name,
    });
    if (shown === undefined) {
      throw new DbError('not-found', msg('{0} does not exist', table.name));
    }
    return text(shown[0]).trim().replace(/;\s*$/u, '');
  }
}
