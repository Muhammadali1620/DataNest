import type { Connection } from 'mysql2/promise';
import { DbError } from '../../core/errors';
import type { ColumnInfo, ObjectScope, TableInfo, TableRef } from '../../core/model/objects';
import type { MetadataReader } from '../driver';
import { groupKeys } from '../common/keys';
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
      `SELECT TABLE_NAME, TABLE_TYPE FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = COALESCE(?, DATABASE())
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
