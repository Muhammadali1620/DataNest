import { DbError } from '../../core/errors';
import type { ColumnInfo, TableInfo, TableRef } from '../../core/model/objects';
import type { CellValue } from '../../shared/cell-value';
import type { MetadataReader } from '../driver';
import type { SqliteParam } from './protocol';

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
}

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
