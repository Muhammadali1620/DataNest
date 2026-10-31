// Structure of an Oracle database from the ALL_* dictionary views: what the user may
// see in every schema. The database itself is the service the connection opens; a
// schema is a user. Definitions come from DBMS_METADATA, without storage clauses.

import { DbError } from '../../core/errors';
import type {
  ColumnDetail,
  ColumnInfo,
  ForeignKey,
  IndexInfo,
  ListedObjectKind,
  ObjectInfo,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
  TableStats,
  TableStructure,
} from '../../core/model/objects';
import { tableStats } from '../common/stats';
import { splitStatements } from '../../core/sql/split';
import type { MetadataReader, TableDump, TypeDump } from '../driver';
import { groupForeignKeys, groupIndexes, groupKeys } from '../common/keys';
import { msg } from '../../core/user-message';

/** Runs one dictionary query with `:name` binds and returns its rows. */
export type OracleRowReader = (sql: string, binds?: Record<string, string>) => Promise<unknown[][]>;

function text(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function optional(value: unknown): string | undefined {
  const result = text(value).trim();
  return result === '' ? undefined : result;
}

/** A column default; Oracle keeps a removed one as the text `NULL`. */
function defaultOf(value: unknown): string | undefined {
  const result = optional(value);
  return result === undefined || result.toUpperCase() === 'NULL' ? undefined : result;
}

/** The schema of a reference, the session's own user when it names none. */
const OWNER = "NVL(:owner, SYS_CONTEXT('USERENV', 'CURRENT_SCHEMA'))";

function owner(scope: ObjectScope): string {
  return scope.schema ?? '';
}

/**
 * A column's type as DDL writes it, from ALL_TAB_COLS (as `c`): `VARCHAR2(255 CHAR)`,
 * `NUMBER(10,2)`, `TIMESTAMP(6)` (the dictionary already says that one in full).
 */
export const TYPE_TEXT = `CASE
  WHEN c.data_type IN ('VARCHAR2', 'CHAR')
    THEN c.data_type || '(' || c.char_length || CASE WHEN c.char_used = 'C' THEN ' CHAR' ELSE ' BYTE' END || ')'
  WHEN c.data_type IN ('NVARCHAR2', 'NCHAR') THEN c.data_type || '(' || c.char_length || ')'
  WHEN c.data_type = 'NUMBER' AND c.data_precision IS NOT NULL
    THEN 'NUMBER(' || c.data_precision || CASE WHEN c.data_scale > 0 THEN ',' || c.data_scale END || ')'
  WHEN c.data_type = 'NUMBER' AND c.data_scale = 0 THEN 'INTEGER'
  WHEN c.data_type = 'FLOAT' THEN 'FLOAT(' || c.data_precision || ')'
  WHEN c.data_type = 'RAW' THEN 'RAW(' || c.data_length || ')'
  ELSE c.data_type
END`;

/** DBMS_METADATA without storage and tablespaces, statements ended as SQL*Plus wants. */
function transforms(refConstraints: boolean): string {
  const set = (name: string, value: string): string =>
    `DBMS_METADATA.SET_TRANSFORM_PARAM(DBMS_METADATA.SESSION_TRANSFORM, '${name}', ${value});`;
  return [
    'BEGIN',
    set('DEFAULT', 'TRUE'),
    set('SEGMENT_ATTRIBUTES', 'FALSE'),
    set('STORAGE', 'FALSE'),
    set('TABLESPACE', 'FALSE'),
    set('SQLTERMINATOR', 'TRUE'),
    set('PRETTY', 'TRUE'),
    set('REF_CONSTRAINTS', refConstraints ? 'TRUE' : 'FALSE'),
    'END;',
  ].join('\n');
}

/** The statements of DDL that DBMS_METADATA joined into one text. */
function statementsOf(ddl: string): string[] {
  return splitStatements(ddl, 'oracle').map((statement) => statement.text.trim());
}

/** Oracle reads an unquoted name in upper case; one with lower-case letters needs a look. */
const LOWER = /\p{Ll}/u;

/** Prefers the exact spelling, then the upper-case one Oracle would read. */
function closest(written: string, found: readonly string[]): string | undefined {
  return found.includes(written) ? written : found.find((name) => name === written.toUpperCase());
}

/** The index Oracle makes for a LOB column by itself. */
const LOB_INDEX = /^SYS_IL\d+C\d+\$\$$/u;

const OBJECT_TYPES: Readonly<Record<string, string>> = {
  table: 'TABLE',
  view: 'VIEW',
  function: 'FUNCTION',
  procedure: 'PROCEDURE',
  trigger: 'TRIGGER',
  sequence: 'SEQUENCE',
};

export class OracleMetadata implements MetadataReader {
  constructor(
    private readonly read: OracleRowReader,
    private readonly service: string,
  ) {}

  /** The one database a connection reaches: the service it names. */
  listDatabases(): Promise<string[]> {
    return Promise.resolve([this.service]);
  }

  /** Users that hold objects of their own, the session's user first; Oracle's own are left out. */
  async listSchemas(): Promise<string[]> {
    const rows = await this.read(
      `SELECT username FROM all_users
       WHERE oracle_maintained = 'N' OR username = SYS_CONTEXT('USERENV', 'SESSION_USER')
       ORDER BY CASE WHEN username = SYS_CONTEXT('USERENV', 'SESSION_USER') THEN 0 ELSE 1 END, username`,
    );
    return rows.map((row) => text(row[0])).filter((name) => name !== '');
  }

  async listTables(written: ObjectScope): Promise<TableInfo[]> {
    const scope = await this.scoped(written);
    // Tables that hold a materialized view's rows belong to the view.
    const rows = await this.read(
      `SELECT table_name, 'TABLE' FROM all_tables t
       WHERE owner = ${OWNER} AND nested = 'NO' AND secondary = 'N'
         AND (iot_type IS NULL OR iot_type = 'IOT') AND dropped = 'NO'
         AND NOT EXISTS (SELECT 1 FROM all_mviews m WHERE m.owner = t.owner AND m.container_name = t.table_name)
       UNION ALL
       SELECT view_name, 'VIEW' FROM all_views WHERE owner = ${OWNER}
       UNION ALL
       SELECT mview_name, 'MVIEW' FROM all_mviews WHERE owner = ${OWNER}
       ORDER BY 1`,
      { owner: owner(scope) },
    );
    return rows.map((row) => {
      const kind = text(row[1]);
      return kind === 'TABLE'
        ? { name: text(row[0]), kind: 'table' as const }
        : {
            name: text(row[0]),
            kind: 'view' as const,
            ...(kind === 'MVIEW' ? { materialized: true } : {}),
          };
    });
  }

  private async columnRows(table: TableRef): Promise<unknown[][]> {
    return await this.read(
      `SELECT c.column_name, ${TYPE_TEXT}, c.nullable, c.data_default,
              c.identity_column, c.virtual_column,
              (SELECT comments FROM all_col_comments cc
               WHERE cc.owner = c.owner AND cc.table_name = c.table_name AND cc.column_name = c.column_name),
              CASE WHEN EXISTS (
                SELECT 1 FROM all_constraints k
                JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
                WHERE k.owner = c.owner AND k.table_name = c.table_name AND k.constraint_type = 'P'
                  AND kc.column_name = c.column_name
              ) THEN 1 ELSE 0 END
       FROM all_tab_cols c
       WHERE c.owner = ${OWNER} AND c.table_name = :name AND c.hidden_column = 'NO'
       ORDER BY c.column_id`,
      { owner: owner(table), name: table.name },
    );
  }

  async tableStats(written: ObjectScope): Promise<TableStats[]> {
    const scope = await this.scoped(written);
    // NUM_ROWS comes from the optimizer statistics and is NULL until they are gathered.
    const rows = await this.read(
      `SELECT c.table_name, t.num_rows, c.comments
       FROM all_tab_comments c
       LEFT JOIN all_tables t ON t.owner = c.owner AND t.table_name = c.table_name
       WHERE c.owner = ${OWNER} AND c.table_type IN ('TABLE', 'VIEW')
       ORDER BY 1`,
      { owner: owner(scope) },
    );
    return rows.map((row) => tableStats(text(row[0]), row[1], undefined, row[2]));
  }

  async listColumns(written: TableRef): Promise<ColumnInfo[]> {
    const table = await this.named(written);
    return (await this.columnRows(table)).map((row) => {
      // An identity column's "default" is its hidden sequence; a virtual one's, its expression.
      const defaultValue = row[4] === 'YES' || row[5] === 'YES' ? undefined : defaultOf(row[3]);
      return {
        name: text(row[0]),
        dataType: text(row[1]),
        nullable: row[2] === 'Y',
        primaryKey: text(row[7]) === '1',
        ...(defaultValue === undefined ? {} : { defaultValue }),
      };
    });
  }

  async listUniqueKeys(written: TableRef): Promise<string[][]> {
    const table = await this.named(written);
    // Function-based indexes name a hidden column (SYS_NC…): they do not identify rows.
    const rows = await this.read(
      `SELECT i.index_name, CASE WHEN ic.column_name LIKE 'SYS\\_NC%' ESCAPE '\\' THEN NULL ELSE ic.column_name END
       FROM all_indexes i
       JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
       WHERE i.table_owner = ${OWNER} AND i.table_name = :name AND i.uniqueness = 'UNIQUE'
         AND NOT EXISTS (SELECT 1 FROM all_constraints k
                         WHERE k.owner = i.table_owner AND k.index_name = i.index_name AND k.constraint_type = 'P')
       ORDER BY i.index_name, ic.column_position`,
      { owner: owner(table), name: table.name },
    );
    return groupKeys(rows.map((row) => [optional(row[0]), optional(row[1])]));
  }

  async listForeignKeys(written: TableRef): Promise<ForeignKey[]> {
    const table = await this.named(written);
    const rows = await this.read(
      `SELECT k.constraint_name, kc.column_name, r.owner, r.table_name, rc.column_name, k.delete_rule
       FROM all_constraints k
       JOIN all_cons_columns kc ON kc.owner = k.owner AND kc.constraint_name = k.constraint_name
       JOIN all_constraints r ON r.owner = k.r_owner AND r.constraint_name = k.r_constraint_name
       JOIN all_cons_columns rc ON rc.owner = r.owner AND rc.constraint_name = r.constraint_name
                               AND rc.position = kc.position
       WHERE k.owner = ${OWNER} AND k.table_name = :name AND k.constraint_type = 'R'
       ORDER BY k.constraint_name, kc.position`,
      { owner: owner(table), name: table.name },
    );
    return groupForeignKeys(
      rows.map((row) => {
        const targetName = optional(row[3]);
        const rule = text(row[5]);
        return {
          id: optional(row[0]),
          name: optional(row[0]),
          column: optional(row[1]),
          target: targetName === undefined ? undefined : { schema: text(row[2]), name: targetName },
          targetColumn: optional(row[4]),
          // Oracle has no ON UPDATE; ON DELETE is CASCADE, SET NULL or NO ACTION.
          onDelete: rule === '' ? undefined : rule,
          onUpdate: 'NO ACTION',
        };
      }),
    );
  }

  async listObjects(written: ObjectScope, kind: ListedObjectKind): Promise<ObjectInfo[]> {
    const scope = await this.scoped(written);
    switch (kind) {
      case 'function':
      case 'procedure': {
        const rows = await this.read(
          `SELECT object_name FROM all_objects
           WHERE owner = ${OWNER} AND object_type = :type ORDER BY object_name`,
          { owner: owner(scope), type: kind.toUpperCase() },
        );
        return rows.map((row) => ({ name: text(row[0]), kind }));
      }
      case 'trigger': {
        const rows = await this.read(
          `SELECT trigger_name, table_name FROM all_triggers
           WHERE owner = ${OWNER} AND base_object_type = 'TABLE' ORDER BY table_name, trigger_name`,
          { owner: owner(scope) },
        );
        return rows.map((row) => ({ name: text(row[0]), kind, table: text(row[1]) }));
      }
      case 'sequence': {
        // Identity columns own a sequence of their own (ISEQ$$_…) that nobody manages by hand.
        const rows = await this.read(
          `SELECT sequence_name FROM all_sequences
           WHERE sequence_owner = ${OWNER} AND sequence_name NOT LIKE 'ISEQ$$\\_%' ESCAPE '\\'
           ORDER BY sequence_name`,
          { owner: owner(scope) },
        );
        return rows.map((row) => ({ name: text(row[0]), kind }));
      }
      case 'event':
        return [];
    }
  }

  async listIndexes(written: TableRef): Promise<IndexInfo[]> {
    const table = await this.named(written);
    const rows = await this.read(
      `SELECT i.index_name, i.uniqueness,
              CASE WHEN EXISTS (SELECT 1 FROM all_constraints k WHERE k.owner = i.table_owner
                                AND k.index_name = i.index_name AND k.constraint_type = 'P') THEN 1 ELSE 0 END,
              CASE WHEN EXISTS (SELECT 1 FROM all_constraints k WHERE k.owner = i.table_owner
                                AND k.index_name = i.index_name AND k.constraint_type = 'U') THEN 1 ELSE 0 END,
              i.index_type,
              CASE WHEN ic.column_name LIKE 'SYS\\_NC%' ESCAPE '\\' THEN NULL ELSE ic.column_name END
       FROM all_indexes i
       JOIN all_ind_columns ic ON ic.index_owner = i.owner AND ic.index_name = i.index_name
       WHERE i.table_owner = ${OWNER} AND i.table_name = :name AND i.index_type <> 'LOB'
       ORDER BY 3 DESC, i.index_name, ic.column_position`,
      { owner: owner(table), name: table.name },
    );
    return groupIndexes(
      rows.map((row) => {
        const type = text(row[4]);
        return {
          name: optional(row[0]),
          column: optional(row[5]),
          unique: text(row[1]) === 'UNIQUE',
          primary: text(row[2]) === '1',
          constraint: text(row[3]) === '1',
          // A plain B-tree is what the designer makes; others keep their kind.
          ...(type === 'NORMAL' ? {} : { method: type }),
        };
      }),
    );
  }

  async describeTable(written: TableRef): Promise<TableStructure> {
    const table = await this.named(written);
    const [relation] = await this.read(
      `SELECT t.table_name,
              (SELECT comments FROM all_tab_comments c WHERE c.owner = t.owner AND c.table_name = t.table_name),
              (SELECT constraint_name FROM all_constraints k
               WHERE k.owner = t.owner AND k.table_name = t.table_name AND k.constraint_type = 'P')
       FROM all_tables t WHERE t.owner = ${OWNER} AND t.table_name = :name`,
      { owner: owner(table), name: table.name },
    );
    if (relation === undefined) {
      throw new DbError('not-found', msg('{0} does not exist', table.name));
    }
    const columns = (await this.columnRows(table)).map((row): ColumnDetail => {
      const generated = row[5] === 'YES';
      const defaultExpression = generated ? undefined : defaultOf(row[3]);
      const comment = optional(row[6]);
      return {
        name: text(row[0]),
        dataType: text(row[1]),
        nullable: row[2] === 'Y',
        autoIncrement: row[4] === 'YES',
        generated,
        ...(defaultExpression === undefined || row[4] === 'YES' ? {} : { defaultExpression }),
        ...(comment === undefined ? {} : { comment }),
      };
    });
    const indexes = await this.listIndexes(table);
    const comment = optional(relation[1]);
    const primaryKeyName = optional(relation[2]);
    return {
      columns,
      primaryKey: indexes.find((index) => index.primary)?.columns ?? [],
      indexes,
      foreignKeys: await this.listForeignKeys(table),
      ...(comment === undefined ? {} : { comment }),
      ...(primaryKeyName === undefined ? {} : { primaryKeyName }),
    };
  }

  async getDefinition(written: ObjectRef): Promise<string[]> {
    if (written.kind === 'event') {
      throw new DbError('unsupported', msg('Oracle keeps scheduled jobs apart, in DBMS_SCHEDULER'));
    }
    const object = await this.named(written);
    if (object.kind === 'table') {
      const parts = await this.tableParts(object, true);
      return [...parts.create, ...parts.after];
    }
    const type =
      object.kind === 'view' && object.materialized === true
        ? 'MATERIALIZED_VIEW'
        : OBJECT_TYPES[object.kind];
    return statementsOf(await this.ddl(type ?? 'TABLE', object));
  }

  async getTableDump(written: TableRef): Promise<TableDump> {
    const table = await this.named(written);
    const parts = await this.tableParts(table, false);
    return { before: [], create: parts.create, after: parts.after, owns: parts.owns };
  }

  listTypeDumps(): Promise<TypeDump[]> {
    return Promise.resolve([]);
  }

  /**
   * The object a name written in SQL means: `orders` is ORDERS unless something is
   * really called `orders`. Names without lower-case letters are taken as they are.
   */
  private async named<T extends { readonly schema?: string; readonly name: string }>(
    ref: T,
  ): Promise<T> {
    if (!LOWER.test(ref.name) && !LOWER.test(ref.schema ?? '')) {
      return ref;
    }
    const rows = await this.read(
      `SELECT owner, object_name FROM all_objects
       WHERE owner IN (${OWNER}, UPPER(${OWNER})) AND object_name IN (:name, UPPER(:name))`,
      { owner: owner(ref), name: ref.name },
    );
    const owners = [...new Set(rows.map((row) => text(row[0])))];
    const schema = ref.schema === undefined ? undefined : closest(ref.schema, owners);
    const names = rows
      .filter((row) => schema === undefined || text(row[0]) === schema)
      .map((row) => text(row[1]));
    const name = closest(ref.name, names);
    return {
      ...ref,
      ...(schema === undefined ? {} : { schema }),
      ...(name === undefined ? {} : { name }),
    };
  }

  /** The schema a scope names, read the way `named` reads object names. */
  private async scoped<T extends ObjectScope>(scope: T): Promise<T> {
    if (scope.schema === undefined || !LOWER.test(scope.schema)) {
      return scope;
    }
    const rows = await this.read(
      'SELECT username FROM all_users WHERE username IN (:owner, UPPER(:owner))',
      { owner: scope.schema },
    );
    const schema = closest(
      scope.schema,
      rows.map((row) => text(row[0])),
    );
    return schema === undefined ? scope : { ...scope, schema };
  }

  /** The table with its indexes and comments, then its foreign keys and triggers. */
  private async tableParts(
    table: TableRef,
    keysInline: boolean,
  ): Promise<{ create: string[]; after: string[]; owns: ObjectRef[] }> {
    const create = statementsOf(await this.ddl('TABLE', table, keysInline));
    const dependent = async (type: string): Promise<string[]> => {
      const rows = await this.read(
        `SELECT DBMS_METADATA.GET_DEPENDENT_DDL(:type, :name, ${OWNER}) FROM dual`,
        { type, name: table.name, owner: owner(table) },
      ).catch((error: unknown) => {
        // ORA-31608: there is nothing of that kind for this table.
        if ((error as { driverCode?: unknown }).driverCode === 'ORA-31608') {
          return [];
        }
        throw error;
      });
      return rows.flatMap((row) => statementsOf(text(row[0])));
    };
    // The indexes behind the primary and unique keys come with CREATE TABLE already.
    const constraintIndexes = new Set(
      (
        await this.read(
          `SELECT index_name FROM all_constraints
           WHERE owner = ${OWNER} AND table_name = :name AND index_name IS NOT NULL`,
          { owner: owner(table), name: table.name },
        )
      ).map((row) => text(row[0])),
    );
    const indexes = (await dependent('INDEX')).filter((sql) => {
      const name = /^\s*CREATE\s+(?:UNIQUE\s+|BITMAP\s+)?INDEX\s+(?:"[^"]+"\.)?"([^"]+)"/iu.exec(
        sql,
      )?.[1];
      // A LOB's own index (SYS_IL…$$, listed nowhere else) is the server's to make.
      return name === undefined || (!constraintIndexes.has(name) && !LOB_INDEX.test(name));
    });
    const comments = await dependent('COMMENT');
    const keys = keysInline ? [] : await dependent('REF_CONSTRAINT');
    const triggers = await dependent('TRIGGER');
    const triggerRows = await this.read(
      `SELECT trigger_name FROM all_triggers WHERE table_owner = ${OWNER} AND table_name = :name`,
      { owner: owner(table), name: table.name },
    );
    return {
      create: [...create, ...indexes, ...comments],
      after: [...keys, ...triggers],
      owns: triggerRows.map((row) => ({
        kind: 'trigger' as const,
        ...(table.schema === undefined ? {} : { schema: table.schema }),
        name: text(row[0]),
        table: table.name,
      })),
    };
  }

  private async ddl(
    type: string,
    object: { schema?: string; name: string },
    refConstraints = true,
  ): Promise<string> {
    await this.read(transforms(refConstraints));
    const [row] = await this.read(
      `SELECT DBMS_METADATA.GET_DDL(:type, :name, ${OWNER}) FROM dual`,
      {
        type,
        name: object.name,
        owner: object.schema ?? '',
      },
    );
    const ddl = text(row?.[0]).trim();
    if (ddl === '') {
      throw new DbError('not-found', msg('{0} does not exist', object.name));
    }
    return ddl;
  }
}
