import type { Connection } from 'mysql2/promise';
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
import type { MetadataReader, TableDump, TypeDump } from '../driver';
import { groupForeignKeys, groupIndexes, groupKeys } from '../common/keys';
import { readMysqlDefinition } from './definitions';
import { readMysqlStructure } from './structure';
import { toMysqlDbError } from './errors';

/** Reads structure from information_schema; shares the session's connection. */
export class MysqlMetadata implements MetadataReader {
  constructor(private readonly conn: Connection) {}

  async listDatabases(): Promise<string[]> {
    const rows = await this.query('SHOW DATABASES');
    const names: string[] = [];
    for (const row of rows) {
      const name = asText(row[0]);
      if (name !== undefined) {
        names.push(name);
      }
    }
    return names.sort((a, b) => a.localeCompare(b));
  }

  listSchemas(): Promise<string[]> {
    return Promise.reject(new DbError('unsupported', 'MySQL has no schemas inside a database'));
  }

  async listTables(scope: ObjectScope): Promise<TableInfo[]> {
    const rows = await this.query(
      // MariaDB lists its sequences here too; they are not tables.
      `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_TYPE <> 'SEQUENCE'
       ORDER BY TABLE_NAME`,
      [scope.database ?? null],
    );
    return rows.map((row) => ({
      name: asText(row[0]) ?? '',
      kind: (asText(row[1]) ?? '').includes('VIEW') ? ('view' as const) : ('table' as const),
    }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const rows = await this.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY, COLUMN_DEFAULT
       FROM information_schema.COLUMNS
       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
       ORDER BY ORDINAL_POSITION`,
      [table.database ?? null, table.name],
    );
    return rows.map((row) => {
      const defaultValue = normalizeDefault(asText(row[4]));
      const info: ColumnInfo = {
        name: asText(row[0]) ?? '',
        dataType: asText(row[1]) ?? '',
        nullable: asText(row[2])?.toUpperCase() === 'YES',
        primaryKey: asText(row[3])?.toUpperCase() === 'PRI',
        ...(defaultValue === undefined ? {} : { defaultValue }),
      };
      return info;
    });
  }

  async listUniqueKeys(table: TableRef): Promise<string[][]> {
    const rows = await this.query(
      `SELECT INDEX_NAME, COLUMN_NAME FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
         AND NON_UNIQUE = 0 AND INDEX_NAME <> 'PRIMARY'
       ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
      [table.database ?? null, table.name],
    );
    return groupKeys(rows.map((row) => [asText(row[0]), asText(row[1])]));
  }

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const rows = await this.query(
      `SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA,
              k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME, r.DELETE_RULE, r.UPDATE_RULE
       FROM information_schema.KEY_COLUMN_USAGE k
       LEFT JOIN information_schema.REFERENTIAL_CONSTRAINTS r
         ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
            AND r.TABLE_NAME = k.TABLE_NAME
       WHERE k.TABLE_SCHEMA = COALESCE(?, DATABASE()) AND k.TABLE_NAME = ?
         AND k.REFERENCED_TABLE_NAME IS NOT NULL
       ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      [table.database ?? null, table.name],
    );
    return groupForeignKeys(
      rows.map((row) => {
        const name = asText(row[0]);
        const targetName = asText(row[3]);
        return {
          id: name,
          name,
          column: asText(row[1]),
          target:
            targetName === undefined
              ? undefined
              : { database: asText(row[2]) ?? table.database ?? '', name: targetName },
          targetColumn: asText(row[4]),
          onDelete: asText(row[5]),
          onUpdate: asText(row[6]),
        };
      }),
    ).map((key) => ({
      ...key,
      target: key.target.database === '' ? { name: key.target.name } : key.target,
    }));
  }

  async listObjects(scope: ObjectScope, kind: ListedObjectKind): Promise<ObjectInfo[]> {
    const schema = [scope.database ?? null];
    switch (kind) {
      case 'function':
      case 'procedure': {
        const rows = await this.query(
          `SELECT ROUTINE_NAME FROM information_schema.ROUTINES
           WHERE ROUTINE_SCHEMA = COALESCE(?, DATABASE()) AND ROUTINE_TYPE = ?
           ORDER BY ROUTINE_NAME`,
          [...schema, kind.toUpperCase()],
        );
        return rows.map((row) => ({ name: asText(row[0]) ?? '', kind }));
      }
      case 'trigger': {
        const rows = await this.query(
          `SELECT TRIGGER_NAME, EVENT_OBJECT_TABLE FROM information_schema.TRIGGERS
           WHERE TRIGGER_SCHEMA = COALESCE(?, DATABASE())
           ORDER BY EVENT_OBJECT_TABLE, ACTION_ORDER, TRIGGER_NAME`,
          schema,
        );
        return rows.map((row) => ({
          name: asText(row[0]) ?? '',
          kind,
          table: asText(row[1]) ?? '',
        }));
      }
      case 'event': {
        const rows = await this.query(
          `SELECT EVENT_NAME FROM information_schema.EVENTS
           WHERE EVENT_SCHEMA = COALESCE(?, DATABASE()) ORDER BY EVENT_NAME`,
          schema,
        );
        return rows.map((row) => ({ name: asText(row[0]) ?? '', kind }));
      }
      case 'sequence': {
        // Only MariaDB has sequences; on MySQL the list is simply empty.
        const rows = await this.query(
          `SELECT TABLE_NAME FROM information_schema.TABLES
           WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_TYPE = 'SEQUENCE'
           ORDER BY TABLE_NAME`,
          schema,
        );
        return rows.map((row) => ({ name: asText(row[0]) ?? '', kind }));
      }
    }
  }

  async listIndexes(table: TableRef): Promise<IndexInfo[]> {
    // COLUMN_NAME is NULL for a functional index part (MySQL 8.0.13+).
    const rows = await this.query(
      `SELECT INDEX_NAME, NON_UNIQUE, COLUMN_NAME, INDEX_TYPE FROM information_schema.STATISTICS
       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE()) AND TABLE_NAME = ?
       ORDER BY INDEX_NAME <> 'PRIMARY', INDEX_NAME, SEQ_IN_INDEX`,
      [table.database ?? null, table.name],
    );
    return groupIndexes(
      rows.map((row) => {
        const name = asText(row[0]);
        const method = asText(row[3]);
        return {
          name,
          column: asText(row[2]),
          unique: asText(row[1]) === '0',
          primary: name === 'PRIMARY',
          ...(method === undefined ? {} : { method }),
        };
      }),
    );
  }

  async describeTable(table: TableRef): Promise<TableStructure> {
    return await readMysqlStructure(
      async (sql, params) => await this.query(sql, params),
      table,
      this,
    );
  }

  async getDefinition(object: ObjectRef): Promise<string[]> {
    return await readMysqlDefinition(async (sql, params) => await this.query(sql, params), object);
  }

  /**
   * SHOW CREATE TABLE keeps foreign keys inline; a dump turns their checks off while
   * it loads, so tables can come in any order. Triggers wait for the data.
   */
  async getTableDump(table: TableRef): Promise<TableDump> {
    const read = async (sql: string, params?: unknown[]): Promise<unknown[][]> =>
      await this.query(sql, params);
    const create = await readMysqlDefinition(read, { ...table, kind: 'table' });
    const triggers = await this.query(
      `SELECT TRIGGER_NAME FROM information_schema.TRIGGERS
       WHERE TRIGGER_SCHEMA = COALESCE(?, DATABASE()) AND EVENT_OBJECT_TABLE = ?
       ORDER BY ACTION_TIMING DESC, EVENT_MANIPULATION, ACTION_ORDER`,
      [table.database ?? null, table.name],
    );
    const after: string[] = [];
    for (const row of triggers) {
      const name = asText(row[0]);
      if (name !== undefined) {
        after.push(...(await readMysqlDefinition(read, { ...table, kind: 'trigger', name })));
      }
    }
    return { before: [], create, after, owns: [] };
  }

  /** MySQL keeps ENUM and SET inside the column type: there are no types of its own. */
  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }

  private async query(sql: string, params: unknown[] = []): Promise<unknown[][]> {
    try {
      const [rows] = await this.conn.query({ sql, values: params, rowsAsArray: true });
      return rows as unknown[][];
    } catch (error) {
      throw toMysqlDbError(error);
    }
  }
}

/**
 * MariaDB stores defaults as SQL expressions: strings arrive quoted and an absent
 * default is the text NULL. MySQL 8 stores the bare value. Normalize to the value.
 */
function normalizeDefault(value: string | undefined): string | undefined {
  if (value === undefined || value === 'NULL') {
    return undefined;
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }
  return value;
}

/** information_schema values are strings or numbers; anything else is treated as absent. */
function asText(value: unknown): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'bigint') {
    return String(value);
  }
  return undefined;
}
