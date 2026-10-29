import type pg from 'pg';
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
import { readPgDefinition } from './definitions';
import { readPgTableDump, readPgTypeDumps } from './dump-definitions';
import { pgReferentialAction, readPgStructure } from './structure';
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
    return rows.map((row) => {
      const relkind = asText(row[1]) ?? '';
      return {
        name: asText(row[0]) ?? '',
        kind: relkind === 'v' || relkind === 'm' ? ('view' as const) : ('table' as const),
        ...(relkind === 'm' ? { materialized: true } : {}),
      };
    });
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

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const rows = await this.query(
      `SELECT con.oid::text, con.conname, a.attname, tn.nspname, tc.relname, ra.attname,
              con.confdeltype::text, con.confupdtype::text
       FROM pg_constraint con
       JOIN pg_class c ON c.oid = con.conrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_class tc ON tc.oid = con.confrelid
       JOIN pg_namespace tn ON tn.oid = tc.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey, con.confkey) WITH ORDINALITY AS k(attnum, refnum, ord)
       JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = k.attnum
       JOIN pg_attribute ra ON ra.attrelid = con.confrelid AND ra.attnum = k.refnum
       WHERE con.contype = 'f' AND n.nspname = $1 AND c.relname = $2
       ORDER BY con.oid, k.ord`,
      [table.schema ?? DEFAULT_SCHEMA, table.name],
    );
    return groupForeignKeys(
      rows.map((row) => {
        const targetName = asText(row[4]);
        return {
          id: asText(row[0]),
          name: asText(row[1]),
          column: asText(row[2]),
          target:
            targetName === undefined
              ? undefined
              : { schema: asText(row[3]) ?? DEFAULT_SCHEMA, name: targetName },
          targetColumn: asText(row[5]),
          onDelete: pgReferentialAction(asText(row[6])),
          onUpdate: pgReferentialAction(asText(row[7])),
        };
      }),
    );
  }

  async listObjects(scope: ObjectScope, kind: ListedObjectKind): Promise<ObjectInfo[]> {
    const schema = scope.schema ?? DEFAULT_SCHEMA;
    switch (kind) {
      case 'function':
      case 'procedure': {
        // Aggregates and window functions have no definition to show; members of
        // extensions (pgcrypto, postgis, …) would bury the user's own functions.
        const rows = await this.query(
          `SELECT p.proname, pg_get_function_identity_arguments(p.oid)
           FROM pg_proc p
           JOIN pg_namespace n ON n.oid = p.pronamespace
           WHERE n.nspname = $1 AND p.prokind = $2
             AND NOT EXISTS (SELECT 1 FROM pg_depend d
                             WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid
                               AND d.deptype = 'e')
           ORDER BY p.proname, 2`,
          [schema, kind === 'procedure' ? 'p' : 'f'],
        );
        return rows.map((row) => ({
          name: asText(row[0]) ?? '',
          kind,
          signature: asText(row[1]) ?? '',
        }));
      }
      case 'trigger': {
        const rows = await this.query(
          `SELECT t.tgname, c.relname
           FROM pg_trigger t
           JOIN pg_class c ON c.oid = t.tgrelid
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND NOT t.tgisinternal
           ORDER BY c.relname, t.tgname`,
          [schema],
        );
        return rows.map((row) => ({
          name: asText(row[0]) ?? '',
          kind,
          table: asText(row[1]) ?? '',
        }));
      }
      case 'sequence': {
        // Identity columns own a sequence of their own that nobody manages by hand.
        const rows = await this.query(
          `SELECT c.relname
           FROM pg_class c
           JOIN pg_namespace n ON n.oid = c.relnamespace
           WHERE n.nspname = $1 AND c.relkind = 'S'
             AND NOT EXISTS (SELECT 1 FROM pg_depend d
                             WHERE d.classid = 'pg_class'::regclass AND d.objid = c.oid
                               AND d.deptype IN ('i', 'e'))
           ORDER BY c.relname`,
          [schema],
        );
        return rows.map((row) => ({ name: asText(row[0]) ?? '', kind }));
      }
      case 'event':
        return [];
    }
  }

  async listIndexes(table: TableRef): Promise<IndexInfo[]> {
    // One row per key part; pg_get_indexdef(oid, n, true) prints a column or an
    // expression the same way the server would.
    const rows = await this.query(
      `SELECT ic.relname, i.indisunique, i.indisprimary, am.amname,
              pg_get_indexdef(i.indexrelid, k.n::int, true),
              pg_get_expr(i.indpred, i.indrelid, true),
              EXISTS (SELECT 1 FROM pg_constraint con
                      WHERE con.conindid = i.indexrelid AND con.contype IN ('u', 'x'))
       FROM pg_index i
       JOIN pg_class ic ON ic.oid = i.indexrelid
       JOIN pg_class c ON c.oid = i.indrelid
       JOIN pg_namespace n ON n.oid = c.relnamespace
       JOIN pg_am am ON am.oid = ic.relam
       CROSS JOIN LATERAL generate_series(1, i.indnkeyatts) AS k(n)
       WHERE n.nspname = $1 AND c.relname = $2
       ORDER BY i.indisprimary DESC, ic.relname, k.n`,
      [table.schema ?? DEFAULT_SCHEMA, table.name],
    );
    return groupIndexes(
      rows.map((row) => {
        const method = asText(row[3]);
        const where = asText(row[5]);
        return {
          name: asText(row[0]),
          column: asText(row[4]),
          unique: row[1] === true,
          primary: row[2] === true,
          constraint: row[6] === true,
          ...(method === undefined ? {} : { method }),
          ...(where === undefined ? {} : { where }),
        };
      }),
    );
  }

  async describeTable(table: TableRef): Promise<TableStructure> {
    return await readPgStructure(async (sql, params) => await this.query(sql, params), table, this);
  }

  async getDefinition(object: ObjectRef): Promise<string[]> {
    return await readPgDefinition(async (sql, params) => await this.query(sql, params), object);
  }

  async getTableDump(table: TableRef): Promise<TableDump> {
    return await readPgTableDump(async (sql, params) => await this.query(sql, params), table);
  }

  async listTypeDumps(scope: ObjectScope, tables?: readonly string[]): Promise<TypeDump[]> {
    return await readPgTypeDumps(
      async (sql, params) => await this.query(sql, params),
      scope.schema,
      tables,
    );
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
