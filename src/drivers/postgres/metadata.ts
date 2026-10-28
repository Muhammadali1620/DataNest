import type pg from 'pg';
import type { ColumnInfo, ObjectScope, TableInfo, TableRef } from '../../core/model/objects';
import type { MetadataReader } from '../driver';
import { groupKeys } from '../common/keys';
import { toPgDbError } from './errors';

const DEFAULT_SCHEMA = 'public';

/** Reads structure from the catalogs; shares the session's connection. */
export class PostgresMetadata implements MetadataReader {
  constructor(private readonly client: pg.Client) {}

  async listDatabases(): Promise<string[]> {
    const rows = await this.query(
      'SELECT datname FROM pg_database WHERE NOT datistemplate ORDER BY datname',
    );
    return rows.map((row) => asText(row[0]) ?? '').filter((name) => name !== '');
  }

  /** Schemas of the connected database; `public` first, the rest alphabetical. */
  async listSchemas(): Promise<string[]> {
    const rows = await this.query(
      `SELECT nspname FROM pg_namespace
       WHERE nspname NOT LIKE 'pg\\_temp\\_%' AND nspname NOT LIKE 'pg\\_toast%'
       ORDER BY nspname <> 'public', nspname`,
    );
    return rows.map((row) => asText(row[0]) ?? '').filter((name) => name !== '');
  }

  async listTables(scope: ObjectScope): Promise<TableInfo[]> {
    const rows = await this.query(
      `SELECT c.relname, c.relkind::text
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = $1 AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
       ORDER BY c.relname`,
      [scope.schema ?? DEFAULT_SCHEMA],
    );
    return rows.map((row) => ({
      name: asText(row[0]) ?? '',
      kind: ['v', 'm'].includes(asText(row[1]) ?? '') ? ('view' as const) : ('table' as const),
    }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const rows = await this.query(
      `SELECT a.attname,
              format_type(a.atttypid, a.atttypmod),
              NOT a.attnotnull,
              COALESCE(i.indisprimary, FALSE),
              pg_get_expr(d.adbin, d.adrelid)
       FROM pg_attribute a
       JOIN pg_class c ON c.oid = a.attrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
       LEFT JOIN pg_index i
         ON i.indrelid = a.attrelid AND i.indisprimary AND a.attnum = ANY (i.indkey)
       WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
       ORDER BY a.attnum`,
      [table.schema ?? DEFAULT_SCHEMA, table.name],
    );
    return rows.map((row) => {
      const defaultValue = asText(row[4]);
      const info: ColumnInfo = {
        name: asText(row[0]) ?? '',
        dataType: asText(row[1]) ?? '',
        nullable: row[2] === true,
        primaryKey: row[3] === true,
        ...(defaultValue === undefined ? {} : { defaultValue }),
      };
      return info;
    });
  }

  async listUniqueKeys(table: TableRef): Promise<string[][]> {
    // Only the key columns count (not INCLUDE ones); partial, expression and
    // not-yet-valid indexes do not identify rows.
    const rows = await this.query(
      `SELECT i.indexrelid::text, a.attname
       FROM pg_index i
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN LATERAL unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
       WHERE i.indisunique AND NOT i.indisprimary AND i.indisvalid
         AND i.indpred IS NULL AND i.indexprs IS NULL AND k.ord <= i.indnkeyatts
         AND n.nspname = $1 AND c.relname = $2
       ORDER BY i.indexrelid, k.ord`,
      [table.schema ?? DEFAULT_SCHEMA, table.name],
    );
    return groupKeys(rows.map((row) => [asText(row[0]), asText(row[1])]));
  }

  private async query(text: string, values: unknown[] = []): Promise<unknown[][]> {
    try {
      const result = await this.client.query({ text, values, rowMode: 'array' });
      return result.rows as unknown[][];
    } catch (error) {
      throw toPgDbError(error);
    }
  }
}

/** Catalog values are strings; anything else is treated as absent. */
function asText(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
