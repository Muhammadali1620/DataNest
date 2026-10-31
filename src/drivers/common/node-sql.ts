// The editable SQL a double click on a column, index or foreign key of the tree opens:
// the statements that would change it, written with its current values, so the user
// edits what differs and runs it (V11.12). Built, never run, here; names go through the
// dialect's quoting, values through its literals. The comments stay in English: they are
// part of the script, like the text of a dump.

import type { ColumnDetail, ForeignKey, IndexInfo, TableRef } from '../../core/model/objects';
import type { DriverId } from '../../shared/connection';
import type { Dialect } from '../driver';

/** What the builders need of a dialect. */
export type NodeSqlDialect = Pick<Dialect, 'quoteIdentifier' | 'quoteTable' | 'literal'>;

const IDENTIFIER = /^[\p{L}_][\p{L}\p{N}_$]*$/u;

/** A plain name is quoted; an expression of an expression index is written as it is. */
function part(dialect: NodeSqlDialect, text: string): string {
  return IDENTIFIER.test(text) ? dialect.quoteIdentifier(text) : text;
}

function list(dialect: NodeSqlDialect, columns: readonly string[]): string {
  return columns.map((column) => part(dialect, column)).join(', ');
}

/** A comment line the user reads and deletes. */
function note(text: string): string {
  return `-- ${text}`;
}

function script(lines: readonly string[]): string {
  return `${lines.join('\n')}\n`;
}

function scopeOf(table: TableRef): { database?: string; schema?: string } {
  return {
    ...(table.database === undefined ? {} : { database: table.database }),
    ...(table.schema === undefined ? {} : { schema: table.schema }),
  };
}

/** `ALTER COLUMN …`, `MODIFY COLUMN …` and the rename and comment statements of a column. */
export function columnSql(
  driver: DriverId,
  dialect: NodeSqlDialect,
  table: TableRef,
  column: ColumnDetail,
): string {
  const target = dialect.quoteTable(table);
  const name = dialect.quoteIdentifier(column.name);
  const comment = column.comment === undefined ? undefined : dialect.literal(column.comment);
  const rename = `ALTER TABLE ${target} RENAME COLUMN ${name} TO ${name};`;
  const nullability = column.nullable ? 'NULL' : 'NOT NULL';
  switch (driver) {
    case 'postgres':
      return script([
        `ALTER TABLE ${target}`,
        `    ALTER COLUMN ${name} TYPE ${column.dataType};`,
        note('change nullability'),
        `ALTER TABLE ${target} ALTER COLUMN ${name} ${column.nullable ? 'DROP' : 'SET'} NOT NULL;`,
        note('change the default'),
        column.defaultExpression === undefined
          ? `ALTER TABLE ${target} ALTER COLUMN ${name} DROP DEFAULT;`
          : `ALTER TABLE ${target} ALTER COLUMN ${name} SET DEFAULT ${column.defaultExpression};`,
        note('change column name'),
        rename,
        note('change column comment'),
        `COMMENT ON COLUMN ${target}.${name} IS ${comment ?? 'NULL'};`,
      ]);
    case 'mysql': {
      const pieces = [column.dataType, nullability];
      if (column.defaultExpression !== undefined) {
        pieces.push(`DEFAULT ${column.defaultExpression}`);
      }
      if (column.autoIncrement) {
        pieces.push('AUTO_INCREMENT');
      }
      if (comment !== undefined) {
        pieces.push(`COMMENT ${comment}`);
      }
      return script([
        `ALTER TABLE ${target}`,
        `    MODIFY COLUMN ${name} ${pieces.join(' ')};`,
        note('change column name'),
        rename,
      ]);
    }
    case 'mssql': {
      const path = [table.schema, table.name, column.name].filter(
        (item): item is string => item !== undefined,
      );
      return script([
        `ALTER TABLE ${target}`,
        `    ALTER COLUMN ${name} ${column.dataType} ${nullability};`,
        note('change column name'),
        `EXEC sp_rename ${dialect.literal(path.join('.'))}, ${dialect.literal(column.name)}, 'COLUMN';`,
      ]);
    }
    case 'oracle':
      return script([
        `ALTER TABLE ${target}`,
        `    MODIFY (${name} ${column.dataType}${
          column.defaultExpression === undefined ? '' : ` DEFAULT ${column.defaultExpression}`
        });`,
        note(`nullability changes with MODIFY (${name} NULL) or MODIFY (${name} NOT NULL)`),
        note('change column name'),
        rename,
        note('change column comment'),
        `COMMENT ON COLUMN ${target}.${name} IS ${comment ?? "''"};`,
      ]);
    case 'clickhouse': {
      const pieces = [column.dataType];
      if (column.defaultExpression !== undefined) {
        pieces.push(`DEFAULT ${column.defaultExpression}`);
      }
      if (comment !== undefined) {
        pieces.push(`COMMENT ${comment}`);
      }
      return script([
        `ALTER TABLE ${target}`,
        `    MODIFY COLUMN ${name} ${pieces.join(' ')};`,
        note('change column name'),
        rename,
        note('change column comment'),
        `ALTER TABLE ${target} COMMENT COLUMN ${name} ${comment ?? "''"};`,
      ]);
    }
    case 'sqlite':
      return script([
        note(
          'SQLite changes the type, default or NOT NULL of a column only by rebuilding the table: use the table designer',
        ),
        note('change column name'),
        rename,
      ]);
    case 'redis':
    case 'mongodb':
    case 'elasticsearch':
      throw new Error('This connection has no SQL columns');
  }
}

/** DROP and CREATE of an index, or of the constraint behind a primary or unique key. */
export function indexSql(
  driver: DriverId,
  dialect: NodeSqlDialect,
  table: TableRef,
  index: IndexInfo,
): string {
  const target = dialect.quoteTable(table);
  const name = dialect.quoteIdentifier(index.name);
  const columns = list(dialect, index.columns);
  const unique = index.unique && !index.primary ? 'UNIQUE ' : '';
  const where = index.where === undefined ? '' : ` WHERE ${index.where}`;
  const method = index.method?.toUpperCase();
  const constraintKey = index.primary
    ? [
        `ALTER TABLE ${target} DROP CONSTRAINT ${name};`,
        `ALTER TABLE ${target} ADD CONSTRAINT ${name} PRIMARY KEY (${columns});`,
      ]
    : [
        `ALTER TABLE ${target} DROP CONSTRAINT ${name};`,
        `ALTER TABLE ${target} ADD CONSTRAINT ${name} UNIQUE (${columns});`,
      ];
  switch (driver) {
    case 'postgres': {
      if (index.primary || index.constraint === true) {
        return script(constraintKey);
      }
      const scope = scopeOf(table);
      const qualified =
        scope.schema === undefined ? name : `${dialect.quoteIdentifier(scope.schema)}.${name}`;
      const using = index.method === undefined ? '' : ` USING ${index.method.toLowerCase()}`;
      return script([
        `DROP INDEX ${qualified};`,
        `CREATE ${unique}INDEX ${name} ON ${target}${using} (${columns})${where};`,
      ]);
    }
    case 'mysql': {
      if (index.primary) {
        return script([
          `ALTER TABLE ${target} DROP PRIMARY KEY;`,
          `ALTER TABLE ${target} ADD PRIMARY KEY (${columns});`,
        ]);
      }
      const kind = method === 'FULLTEXT' || method === 'SPATIAL' ? `${method} ` : unique;
      const using = method === 'BTREE' || method === 'HASH' ? ` USING ${method}` : '';
      return script([
        `DROP INDEX ${name} ON ${target};`,
        `CREATE ${kind}INDEX ${name} ON ${target} (${columns})${using};`,
      ]);
    }
    case 'mssql':
      return index.primary
        ? script(constraintKey)
        : script([
            `DROP INDEX ${name} ON ${target};`,
            `CREATE ${unique}${method === 'CLUSTERED' ? 'CLUSTERED ' : 'NONCLUSTERED '}INDEX ${name} ON ${target} (${columns})${where};`,
          ]);
    case 'oracle': {
      if (index.primary) {
        return script(constraintKey);
      }
      const owner = table.schema ?? table.database;
      const qualified = owner === undefined ? name : `${dialect.quoteIdentifier(owner)}.${name}`;
      return script([
        `DROP INDEX ${qualified};`,
        `CREATE ${unique}INDEX ${name} ON ${target} (${columns});`,
      ]);
    }
    case 'sqlite':
      return index.primary
        ? script([
            note(
              'The primary key of a SQLite table is part of the table: change it with the table designer',
            ),
          ])
        : script([
            `DROP INDEX ${name};`,
            `CREATE ${unique}INDEX ${name} ON ${target} (${columns})${where};`,
          ]);
    case 'clickhouse':
      return index.primary
        ? script([
            note('The primary key of a ClickHouse table is its sorting key and cannot be changed'),
          ])
        : script([
            `ALTER TABLE ${target} DROP INDEX ${name};`,
            `ALTER TABLE ${target} ADD INDEX ${name} (${columns}) TYPE ${index.method ?? 'minmax'} GRANULARITY 1;`,
          ]);
    case 'redis':
    case 'mongodb':
    case 'elasticsearch':
      throw new Error('This connection has no SQL indexes');
  }
}

/** DROP and ADD of a foreign key with its columns and referential actions. */
export function foreignKeySql(
  driver: DriverId,
  dialect: NodeSqlDialect,
  table: TableRef,
  key: ForeignKey,
): string {
  const target = dialect.quoteTable(table);
  const name = dialect.quoteIdentifier(key.name);
  const actions = [
    key.onDelete === undefined || key.onDelete === 'NO ACTION' ? '' : ` ON DELETE ${key.onDelete}`,
    // Oracle has no ON UPDATE.
    driver === 'oracle' || key.onUpdate === undefined || key.onUpdate === 'NO ACTION'
      ? ''
      : ` ON UPDATE ${key.onUpdate}`,
  ].join('');
  const add = `ALTER TABLE ${target} ADD CONSTRAINT ${name} FOREIGN KEY (${list(
    dialect,
    key.columns,
  )}) REFERENCES ${dialect.quoteTable(key.target)} (${list(dialect, key.targetColumns)})${actions};`;
  switch (driver) {
    case 'mysql':
      return script([`ALTER TABLE ${target} DROP FOREIGN KEY ${name};`, add]);
    case 'postgres':
    case 'mssql':
    case 'oracle':
      return script([`ALTER TABLE ${target} DROP CONSTRAINT ${name};`, add]);
    case 'sqlite':
      return script([
        note('SQLite changes foreign keys only by rebuilding the table: use the table designer'),
        note(add),
      ]);
    case 'clickhouse':
      return script([note('ClickHouse has no foreign keys')]);
    case 'redis':
    case 'mongodb':
    case 'elasticsearch':
      throw new Error('This connection has no SQL foreign keys');
  }
}

/** PostgreSQL 14 can replace a trigger in place, which is what editing one comes to. */
export function triggerStatements(driver: DriverId, statements: readonly string[]): string[] {
  return driver === 'postgres'
    ? statements.map((statement) =>
        statement.replace(/^(\s*)CREATE\s+TRIGGER\b/iu, '$1CREATE OR REPLACE TRIGGER'),
      )
    : [...statements];
}
