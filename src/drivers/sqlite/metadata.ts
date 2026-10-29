import { DbError } from '../../core/errors';
import type {
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectInfo,
  ObjectRef,
  TableInfo,
  TableRef,
  TableStructure,
} from '../../core/model/objects';
import type { CellValue } from '../../shared/cell-value';
import type { MetadataReader, TableDump, TypeDump } from '../driver';
import { groupForeignKeys, groupIndexes, groupKeys } from '../common/keys';
import { quoteIdentifier } from './dialect';
import type { SqliteParam } from './protocol';
import { readSqliteStructure } from './structure';

/** What metadata needs from the session, kept narrow for tests. */
export interface SqliteQueryRunner {
  queryRows(sql: string, params: readonly SqliteParam[]): Promise<CellValue[][]>;
}

/** Reads structure from sqlite_master and the pragma functions. */
export class SqliteMetadata implements MetadataReader {
  constructor(private readonly session: SqliteQueryRunner) {}

  /** A SQLite file is a single database: the tree skips this level. */
  listDatabases(): Promise<string[]> {
    return Promise.resolve([]);
  }

  listSchemas(): Promise<string[]> {
    return Promise.reject(new DbError('unsupported', 'SQLite has no schemas'));
  }

  async listTables(): Promise<TableInfo[]> {
    const rows = await this.session.queryRows(
      `SELECT name, type FROM sqlite_master
       WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%'
       ORDER BY name`,
      [],
    );
    return rows.map((row) => ({
      name: asText(row[0]) ?? '',
      kind: asText(row[1]) === 'view' ? ('view' as const) : ('table' as const),
    }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const rows = await this.session.queryRows(
      `SELECT name, type, "notnull", pk, dflt_value FROM pragma_table_info(?) ORDER BY cid`,
      [table.name],
    );
    return rows.map((row) => {
      const defaultValue = asText(row[4]);
      const info: ColumnInfo = {
        name: asText(row[0]) ?? '',
        dataType: (asText(row[1]) ?? '').toLowerCase(),
        nullable: asNumber(row[2]) === 0,
        primaryKey: (asNumber(row[3]) ?? 0) > 0,
        ...(defaultValue === undefined ? {} : { defaultValue }),
      };
      return info;
    });
  }

  async listUniqueKeys(table: TableRef): Promise<string[][]> {
    // origin 'pk' is the primary key, which listColumns already reports.
    const rows = await this.session.queryRows(
      `SELECT l.name, i.name FROM pragma_index_list(?) AS l
       JOIN pragma_index_info(l.name) AS i
       WHERE l."unique" = 1 AND l.origin <> 'pk' AND l.partial = 0
       ORDER BY l.name, i.seqno`,
      [table.name],
    );
    return groupKeys(rows.map((row) => [asText(row[0]), asText(row[1])]));
  }

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const rows = await this.session.queryRows(
      `SELECT id, seq, "table", "from", "to", on_delete, on_update
       FROM pragma_foreign_key_list(?) ORDER BY id, seq`,
      [table.name],
    );
    // A key written without target columns points at the other table's primary key.
    const primaryKeys = new Map<string, string[]>();
    const keyOf = async (name: string): Promise<string[]> => {
      const known = primaryKeys.get(name);
      if (known !== undefined) {
        return known;
      }
      const columns = await this.listColumns({ name });
      const key = columns.filter((column) => column.primaryKey).map((column) => column.name);
      primaryKeys.set(name, key);
      return key;
    };
    const resolved: ForeignKeyRowLike[] = [];
    for (const row of rows) {
      const target = asText(row[2]);
      const explicit = asText(row[4]);
      const position = asNumber(row[1]) ?? 0;
      resolved.push({
        id: asText(row[0]),
        name: undefined,
        column: asText(row[3]),
        target: target === undefined ? undefined : { name: target },
        targetColumn:
          explicit ?? (target === undefined ? undefined : (await keyOf(target))[position]),
        onDelete: asText(row[5]),
        onUpdate: asText(row[6]),
      });
    }
    return groupForeignKeys(resolved).map((key, index) => ({ ...key, name: `fk_${index + 1}` }));
  }

  /** SQLite has triggers only: no routines, sequences or events to list. */
  async listObjects(_scope: unknown, kind: ListedObjectKind): Promise<ObjectInfo[]> {
    if (kind !== 'trigger') {
      return [];
    }
    const rows = await this.session.queryRows(
      `SELECT name, tbl_name FROM sqlite_master WHERE type = 'trigger' ORDER BY tbl_name, name`,
      [],
    );
    return rows.map((row) => ({ name: asText(row[0]) ?? '', kind, table: asText(row[1]) ?? '' }));
  }

  async listIndexes(table: TableRef): Promise<IndexInfo[]> {
    // An INTEGER PRIMARY KEY is the rowid itself and has no index to list.
    const rows = await this.session.queryRows(
      `SELECT l.name, l."unique", l.origin, i.name FROM pragma_index_list(?) AS l
       JOIN pragma_index_xinfo(l.name) AS i
       WHERE i."key" = 1
       ORDER BY l.origin <> 'pk', l.name, i.seqno`,
      [table.name],
    );
    return groupIndexes(
      rows.map((row) => ({
        name: asText(row[0]),
        column: asText(row[3]),
        unique: asNumber(row[1]) === 1,
        primary: asText(row[2]) === 'pk',
      })),
    );
  }

  async describeTable(table: TableRef): Promise<TableStructure> {
    return await readSqliteStructure(this.session, table, this);
  }

  /**
   * SQLite keeps the original CREATE text of every object. A table brings its
   * indexes and triggers along; indexes behind keys have no text and need none.
   */
  async getDefinition(object: ObjectRef): Promise<string[]> {
    if (object.kind !== 'table' && object.kind !== 'view' && object.kind !== 'trigger') {
      throw new DbError('unsupported', `SQLite has no ${object.kind}s`);
    }
    const master =
      object.database === undefined
        ? 'sqlite_master'
        : `${quoteIdentifier(object.database)}.sqlite_master`;
    const own = await this.session.queryRows(
      `SELECT sql FROM ${master} WHERE type = ? AND name = ? AND sql IS NOT NULL`,
      [object.kind, object.name],
    );
    const first = asText(own[0]?.[0]);
    if (first === undefined) {
      throw new DbError('not-found', `${object.name} does not exist`);
    }
    if (object.kind === 'trigger') {
      return [first];
    }
    const related = await this.session.queryRows(
      `SELECT sql FROM ${master}
       WHERE type IN ('index', 'trigger') AND tbl_name = ? AND sql IS NOT NULL
       ORDER BY type, name`,
      [object.name],
    );
    return [first, ...related.map((row) => asText(row[0]) ?? '').filter((sql) => sql !== '')];
  }

  /** The table and its indexes; its triggers wait for the data, so they do not fire on it. */
  async getTableDump(table: TableRef): Promise<TableDump> {
    const master =
      table.database === undefined
        ? 'sqlite_master'
        : `${quoteIdentifier(table.database)}.sqlite_master`;
    const rows = await this.session.queryRows(
      `SELECT type, sql FROM ${master}
       WHERE tbl_name = ? AND type IN ('table', 'index', 'trigger') AND sql IS NOT NULL
       ORDER BY CASE type WHEN 'table' THEN 0 WHEN 'index' THEN 1 ELSE 2 END, name`,
      [table.name],
    );
    if (!rows.some((row) => row[0] === 'table')) {
      throw new DbError('not-found', `${table.name} does not exist`);
    }
    const create: string[] = [];
    const after: string[] = [];
    for (const row of rows) {
      const sql = asText(row[1]);
      if (sql !== undefined && sql !== '') {
        (row[0] === 'trigger' ? after : create).push(sql);
      }
    }
    return { before: [], create, after, owns: [] };
  }

  /** SQLite has no types of its own. */
  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }
}

type ForeignKeyRowLike = Parameters<typeof groupForeignKeys>[0][number];

function asText(value: CellValue | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

function asNumber(value: CellValue | undefined): number | undefined {
  return typeof value === 'number' ? value : undefined;
}
