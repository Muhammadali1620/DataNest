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
import {
  DEFAULT_SCHEMA,
  flag,
  type MssqlRowReader,
  objectName,
  optionalText,
  schemaOf,
  text,
  TYPE_TEXT,
  unwrapDefault,
} from './catalog';
import { readMssqlDefinition } from './definitions';
import { readMssqlTableDump } from './dump-definitions';
import { mssqlReferentialAction, readMssqlStructure } from './structure';

/** Reads structure from the `sys` catalog views of the session's database. */
export class MssqlMetadata implements MetadataReader {
  constructor(private readonly read: MssqlRowReader) {}

  /** Databases this login may open; the others would only fail when expanded. */
  async listDatabases(): Promise<string[]> {
    const rows = await this.read(
      'SELECT name FROM sys.databases WHERE HAS_DBACCESS(name) = 1 ORDER BY name',
    );
    return rows.map((row) => text(row[0])).filter((name) => name !== '');
  }

  /**
   * Schemas of the session's database, `dbo` first. The fixed role schemas
   * (`db_owner`, `db_datareader`, …) hold nothing and are left out.
   */
  async listSchemas(): Promise<string[]> {
    const rows = await this.read(
      `SELECT name FROM sys.schemas WHERE schema_id < 16384
       ORDER BY CASE WHEN name = 'dbo' THEN 0 ELSE 1 END, name`,
    );
    return rows.map((row) => text(row[0])).filter((name) => name !== '');
  }

  async listTables(scope: ObjectScope): Promise<TableInfo[]> {
    const rows = await this.read(
      `SELECT o.name, RTRIM(o.type)
       FROM sys.objects o
       WHERE o.schema_id = SCHEMA_ID(@p1) AND o.type IN ('U', 'V') AND o.is_ms_shipped = 0
       ORDER BY o.name`,
      [schemaOf(scope)],
    );
    return rows.map((row) => ({
      name: text(row[0]),
      kind: text(row[1]) === 'V' ? ('view' as const) : ('table' as const),
    }));
  }

  async listColumns(table: TableRef): Promise<ColumnInfo[]> {
    const rows = await this.read(
      `SELECT c.name, ${TYPE_TEXT}, c.is_nullable,
              CASE WHEN EXISTS (
                SELECT 1 FROM sys.indexes i
                JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
                WHERE i.object_id = c.object_id AND i.is_primary_key = 1 AND ic.column_id = c.column_id
              ) THEN 1 ELSE 0 END,
              dc.definition
       FROM sys.columns c
       JOIN sys.types t ON t.user_type_id = c.user_type_id
       LEFT JOIN sys.default_constraints dc ON dc.object_id = c.default_object_id
       WHERE c.object_id = OBJECT_ID(@p1)
       ORDER BY c.column_id`,
      [objectName(table)],
    );
    return rows.map((row) => {
      const defaultValue = optionalText(row[4]);
      return {
        name: text(row[0]),
        dataType: text(row[1]),
        nullable: flag(row[2]),
        primaryKey: flag(row[3]),
        ...(defaultValue === undefined ? {} : { defaultValue: unwrapDefault(defaultValue) }),
      };
    });
  }

  async listUniqueKeys(table: TableRef): Promise<string[][]> {
    // Filtered and disabled indexes do not identify rows; included columns are not keys.
    const rows = await this.read(
      `SELECT CAST(i.index_id AS varchar(10)), c.name
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(@p1) AND i.is_unique = 1 AND i.is_primary_key = 0
         AND i.has_filter = 0 AND i.is_disabled = 0 AND ic.is_included_column = 0
       ORDER BY i.index_id, ic.key_ordinal`,
      [objectName(table)],
    );
    return groupKeys(rows.map((row) => [optionalText(row[0]), optionalText(row[1])]));
  }

  async listForeignKeys(table: TableRef): Promise<ForeignKey[]> {
    const rows = await this.read(
      `SELECT CAST(fk.object_id AS varchar(20)), fk.name, pc.name,
              SCHEMA_NAME(rt.schema_id), rt.name, rc.name,
              fk.delete_referential_action_desc, fk.update_referential_action_desc
       FROM sys.foreign_keys fk
       JOIN sys.foreign_key_columns fkc ON fkc.constraint_object_id = fk.object_id
       JOIN sys.columns pc ON pc.object_id = fkc.parent_object_id AND pc.column_id = fkc.parent_column_id
       JOIN sys.tables rt ON rt.object_id = fkc.referenced_object_id
       JOIN sys.columns rc ON rc.object_id = fkc.referenced_object_id AND rc.column_id = fkc.referenced_column_id
       WHERE fk.parent_object_id = OBJECT_ID(@p1)
       ORDER BY fk.object_id, fkc.constraint_column_id`,
      [objectName(table)],
    );
    return groupForeignKeys(
      rows.map((row) => {
        const targetName = optionalText(row[4]);
        return {
          id: optionalText(row[0]),
          name: optionalText(row[1]),
          column: optionalText(row[2]),
          target:
            targetName === undefined
              ? undefined
              : { schema: optionalText(row[3]) ?? DEFAULT_SCHEMA, name: targetName },
          targetColumn: optionalText(row[5]),
          onDelete: mssqlReferentialAction(optionalText(row[6])),
          onUpdate: mssqlReferentialAction(optionalText(row[7])),
        };
      }),
    );
  }

  async listObjects(scope: ObjectScope, kind: ListedObjectKind): Promise<ObjectInfo[]> {
    const schema = schemaOf(scope);
    switch (kind) {
      case 'function':
      case 'procedure': {
        // Scalar, inline and table-valued functions, CLR ones too; procedures likewise.
        const types = kind === 'function' ? "('FN', 'IF', 'TF', 'FS', 'FT')" : "('P', 'PC')";
        const rows = await this.read(
          `SELECT name FROM sys.objects
           WHERE schema_id = SCHEMA_ID(@p1) AND type IN ${types} AND is_ms_shipped = 0
           ORDER BY name`,
          [schema],
        );
        return rows.map((row) => ({ name: text(row[0]), kind }));
      }
      case 'trigger': {
        const rows = await this.read(
          `SELECT tr.name, p.name
           FROM sys.triggers tr
           JOIN sys.objects p ON p.object_id = tr.parent_id
           WHERE tr.parent_class = 1 AND p.schema_id = SCHEMA_ID(@p1) AND tr.is_ms_shipped = 0
           ORDER BY p.name, tr.name`,
          [schema],
        );
        return rows.map((row) => ({ name: text(row[0]), kind, table: text(row[1]) }));
      }
      case 'sequence': {
        const rows = await this.read(
          'SELECT name FROM sys.sequences WHERE schema_id = SCHEMA_ID(@p1) ORDER BY name',
          [schema],
        );
        return rows.map((row) => ({ name: text(row[0]), kind }));
      }
      case 'event':
        return [];
    }
  }

  async listIndexes(table: TableRef): Promise<IndexInfo[]> {
    // Heaps (type 0) are not indexes. Columnstore indexes have no key order, so their
    // columns come in the order they were listed.
    const rows = await this.read(
      `SELECT i.name, i.is_unique, i.is_primary_key, i.type_desc, c.name, i.filter_definition,
              i.is_unique_constraint
       FROM sys.indexes i
       JOIN sys.index_columns ic ON ic.object_id = i.object_id AND ic.index_id = i.index_id
       JOIN sys.columns c ON c.object_id = ic.object_id AND c.column_id = ic.column_id
       WHERE i.object_id = OBJECT_ID(@p1) AND i.type > 0
         AND (ic.is_included_column = 0 OR i.type IN (5, 6))
       ORDER BY i.is_primary_key DESC, i.name,
                CASE WHEN ic.key_ordinal = 0 THEN ic.index_column_id ELSE ic.key_ordinal END`,
      [objectName(table)],
    );
    return groupIndexes(
      rows.map((row) => {
        const where = optionalText(row[5]);
        return {
          name: optionalText(row[0]),
          column: optionalText(row[4]),
          unique: flag(row[1]),
          primary: flag(row[2]),
          constraint: flag(row[6]),
          method: text(row[3]),
          ...(where === undefined ? {} : { where: unwrapDefault(where) }),
        };
      }),
    );
  }

  async describeTable(table: TableRef): Promise<TableStructure> {
    return await readMssqlStructure(this.read, table, this);
  }

  async getDefinition(object: ObjectRef): Promise<string[]> {
    return await readMssqlDefinition(this.read, object, this);
  }

  async getTableDump(table: TableRef): Promise<TableDump> {
    return await readMssqlTableDump(this.read, table, this);
  }

  /** Types live in the columns here; alias types are rare enough to be written as their base. */
  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }
}
