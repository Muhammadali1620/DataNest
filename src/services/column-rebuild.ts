// Moving a column where the database cannot (PostgreSQL, SQL Server, Oracle keep the
// order columns were created in): a script that rebuilds the table with the columns in
// the new order, opened for review and never run by itself (D116). The data goes to a
// backup table first, the table is dropped and created again from the structure the
// designer reads, the rows are copied back, and what the drop took with it is created
// again: foreign keys of other tables, checks, triggers, identity counters.
// Pure: the caller reads the structure and the things that depend on the table.

import { DbError } from '../core/errors';
import type { ForeignKey, TableRef, TableStructure } from '../core/model/objects';
import { msg } from '../core/user-message';
import type { Dialect } from '../drivers/driver';
import type { DriverId } from '../shared/connection';
import type { ColumnDesign, TableDesign } from '../shared/table-design';
import type { MoveDirection } from './column-move';
import { addCheckSql } from './table-checks';
import { designFromStructure } from './table-structure';

export type { MoveDirection };

/** Databases whose columns cannot change places in place but whose table can be rebuilt. */
export const REBUILD_DRIVERS: ReadonlySet<DriverId> = new Set(['postgres', 'mssql', 'oracle']);

export interface ReferencingKey {
  /** The table that holds the key. */
  readonly table: TableRef;
  readonly key: ForeignKey;
}

export interface TriggerScript {
  readonly name: string;
  readonly statements: readonly string[];
}

export interface RebuildInput {
  readonly driver: DriverId;
  readonly dialect: Dialect;
  readonly table: TableRef;
  readonly structure: TableStructure;
  readonly column: string;
  readonly direction: MoveDirection;
  /** Foreign keys of other tables that point at this one: they are dropped and added back. */
  readonly referencing: readonly ReferencingKey[];
  /** The triggers of this table: the drop takes them along. */
  readonly triggers: readonly TriggerScript[];
  /** How many tables were looked through for foreign keys, when not all were. */
  readonly checkedTables?: number;
}

/** The suffix of the backup table the script makes and drops. */
const BACKUP_SUFFIX = '__order_backup';

const SEQUENCE_DEFAULT = /nextval\(\s*'((?:[^']|'')+)'(?:\s*::\s*regclass)?\s*\)/iu;

function comment(lines: readonly string[]): string {
  return lines.map((line) => `-- ${line}`.trimEnd()).join('\n');
}

/**
 * The script that moves `column` one place, or undefined when it is at the edge. Throws
 * `unsupported` where the table cannot be rebuilt this way (computed columns).
 */
export function rebuildReorderScript(input: RebuildInput): string | undefined {
  const { driver, dialect, table, structure, column, direction } = input;
  if (!REBUILD_DRIVERS.has(driver)) {
    throw new DbError('unsupported', msg('This database cannot rebuild a table to move a column'));
  }
  const { design, background } = designFromStructure(table, structure);
  const from = design.columns.findIndex((candidate) => candidate.original === column);
  if (from < 0) {
    throw new DbError('unsupported', msg('The column "{0}" cannot be moved from here', column));
  }
  const to = direction === 'up' ? from - 1 : from + 1;
  const moved = design.columns[from];
  const neighbour = design.columns[to];
  if (moved === undefined || neighbour === undefined) {
    return undefined;
  }
  if (background.generatedColumns.length > 0) {
    throw new DbError(
      'unsupported',
      msg(
        'The table has computed columns ({0}): they cannot be carried over, so its columns are not moved by a rebuild',
        background.generatedColumns.join(', '),
      ),
    );
  }
  const columns = [...design.columns];
  columns[from] = neighbour;
  columns[to] = moved;
  const reordered: TableDesign = { ...design, columns };

  const flavour = FLAVOURS[driver as 'postgres' | 'mssql' | 'oracle'];
  const target = dialect.quoteTable(table);
  const backup = dialect.quoteTable({ ...table, name: `${table.name}${BACKUP_SUFFIX}` });
  const names = columns.map((item) => dialect.quoteIdentifier(item.name));
  const identity = columns.filter((item) => item.autoIncrement);
  const sequences = columns.flatMap((item) => {
    const found = SEQUENCE_DEFAULT.exec(item.defaultValue);
    return found?.[1] === undefined || item.autoIncrement
      ? []
      : [{ column: item, sequence: found[1].replace(/''/gu, "'") }];
  });

  const fixed = structure.indexes.filter((index) =>
    background.fixedIndexes.some((kept) => kept.name === index.name),
  );
  const statements: string[] = [];
  const step = (title: string): void => {
    statements.push(`-- ${title}`);
  };

  statements.push(...flavour.begin);
  if (input.referencing.length > 0) {
    step('Foreign keys of other tables that point here are dropped, and added back at the end');
    for (const { table: other, key } of input.referencing) {
      statements.push(
        `ALTER TABLE ${dialect.quoteTable(other)} DROP CONSTRAINT ${dialect.quoteIdentifier(key.name)}`,
      );
    }
  }
  if (flavour.sequencesAreOwned && sequences.length > 0) {
    step('The sequences behind the defaults survive the drop of the table');
    for (const { sequence } of sequences) {
      statements.push(`ALTER SEQUENCE ${sequence} OWNED BY NONE`);
    }
  }
  step('Copy the rows to a backup table');
  statements.push(flavour.backup(target, backup));
  step('Create the table again with the columns in the new order');
  statements.push(`DROP TABLE ${target}`);
  statements.push(...dialect.ddl.createTable(table, reordered));
  for (const index of fixed) {
    statements.push(flavour.fixedIndex(dialect, table, index));
  }
  for (const check of structure.checks ?? []) {
    statements.push(addCheckSql(dialect, table, check.name, check.expression));
  }
  for (const trigger of input.triggers) {
    step(`Trigger ${trigger.name}`);
    statements.push(...trigger.statements);
  }
  step('Put the rows back');
  statements.push(...flavour.restore(dialect, target, backup, names, identity));
  if (flavour.sequencesAreOwned) {
    for (const { column: owner, sequence } of sequences) {
      statements.push(
        `ALTER SEQUENCE ${sequence} OWNED BY ${target}.${dialect.quoteIdentifier(owner.name)}`,
      );
    }
  }
  if (input.referencing.length > 0) {
    step('Foreign keys of other tables, as they were');
    for (const { table: other, key } of input.referencing) {
      statements.push(foreignKeySql(dialect, driver, other, key, target));
    }
  }
  statements.push(`DROP TABLE ${backup}`);
  statements.push(...flavour.commit);

  return `${header(input, moved, direction, flavour)}\n\n${statements
    .map((line) => (line.startsWith('--') ? line : `${line};`))
    .join('\n')}\n`;
}

function header(
  input: RebuildInput,
  moved: ColumnDesign,
  direction: MoveDirection,
  flavour: Flavour,
): string {
  const { table, structure } = input;
  const own = structure.foreignKeys.length;
  const lines = [
    `Move column ${moved.name} ${direction} in ${table.name}.`,
    `${flavour.product} keeps columns in the order they were created, so this script rebuilds the table:`,
    'rows are copied to a backup table, the table is created again with the columns in the new order,',
    'the rows are copied back and the backup is dropped. Read it before you run it.',
    '',
    flavour.safety,
    '',
    `Created again: columns, defaults, identity, primary key, indexes, ${own} foreign key(s) of this table,`,
    `${(structure.checks ?? []).length} check(s), ${input.triggers.length} trigger(s), comments, and the ${input.referencing.length} foreign key(s) of other tables that point here.`,
    'NOT carried over: privileges (GRANT), row-level security policies, partitioning, statistics,',
    'and views or routines that use the table: drop them first and create them again after, or the drop below fails.',
  ];
  if (input.checkedTables !== undefined) {
    lines.push(
      '',
      `Only ${input.checkedTables} tables of the schema were searched for foreign keys that point here.`,
    );
  } else {
    lines.push('', 'Foreign keys from tables of other schemas are not searched.');
  }
  return comment(lines);
}

function foreignKeySql(
  dialect: Dialect,
  driver: DriverId,
  holder: TableRef,
  key: ForeignKey,
  target: string,
): string {
  const quote = (name: string): string => dialect.quoteIdentifier(name);
  const actions = [
    ['ON DELETE', key.onDelete],
    // Oracle has no ON UPDATE.
    ...(driver === 'oracle' ? [] : ([['ON UPDATE', key.onUpdate]] as const)),
  ]
    .filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && entry[1] !== '' && entry[1].toUpperCase() !== 'NO ACTION',
    )
    // Oracle knows only CASCADE and SET NULL.
    .filter(
      ([, action]) => driver !== 'oracle' || ['CASCADE', 'SET NULL'].includes(action.toUpperCase()),
    )
    .map(([word, action]) => ` ${word} ${action.toUpperCase()}`)
    .join('');
  return `ALTER TABLE ${dialect.quoteTable(holder)} ADD CONSTRAINT ${quote(key.name)} FOREIGN KEY (${key.columns
    .map(quote)
    .join(', ')}) REFERENCES ${target} (${key.targetColumns.map(quote).join(', ')})${actions}`;
}

interface Flavour {
  readonly product: string;
  /** What the user is told about a failure half way. */
  readonly safety: string;
  readonly begin: readonly string[];
  readonly commit: readonly string[];
  /** The default of a column is a sequence that the drop of the table would take. */
  readonly sequencesAreOwned: boolean;
  backup(target: string, backup: string): string;
  restore(
    dialect: Dialect,
    target: string,
    backup: string,
    columns: readonly string[],
    identity: readonly ColumnDesign[],
  ): string[];
  fixedIndex(dialect: Dialect, table: TableRef, index: TableStructure['indexes'][number]): string;
}

/** An index the designer does not edit, written by hand where the database's words are known. */
function describedIndex(index: TableStructure['indexes'][number]): string {
  const kind = [index.unique ? 'UNIQUE' : '', index.method ?? ''].filter((part) => part !== '');
  const where = index.where === undefined ? '' : ` WHERE ${index.where}`;
  return `-- Create again by hand: ${index.name} ${kind.join(' ')} (${index.columns.join(', ')})${where}`.replace(
    /\s+/gu,
    ' ',
  );
}

const FLAVOURS: Readonly<Record<'postgres' | 'mssql' | 'oracle', Flavour>> = {
  postgres: {
    product: 'PostgreSQL',
    safety: 'It runs in one transaction: if a step fails, nothing has changed.',
    begin: ['BEGIN'],
    commit: ['COMMIT'],
    sequencesAreOwned: true,
    backup: (target, backup) => `CREATE TABLE ${backup} AS SELECT * FROM ${target}`,
    restore: (dialect, target, backup, columns, identity) => {
      const list = columns.join(', ');
      const override = identity.length > 0 ? ' OVERRIDING SYSTEM VALUE' : '';
      return [
        `INSERT INTO ${target} (${list})${override} SELECT ${list} FROM ${backup}`,
        // The identity counter of the new table starts at 1: set it past the rows.
        ...identity.map((column) => {
          const quoted = dialect.quoteIdentifier(column.name);
          const text = (value: string): string => `'${value.replace(/'/gu, "''")}'`;
          return `SELECT setval(pg_get_serial_sequence(${text(target)}, ${text(column.name)}), COALESCE(MAX(${quoted}) + 1, 1), false) FROM ${target}`;
        }),
      ];
    },
    fixedIndex: (dialect, table, index) => {
      const known = new Set(['btree', 'hash', 'gin', 'gist', 'spgist', 'brin']);
      const method = index.method !== undefined && known.has(index.method.toLowerCase());
      // Key parts that are not plain names are expressions: kept as the server wrote them.
      const parts = index.columns.map((part) =>
        /^[A-Za-z_][\w$]*$/u.test(part) ? dialect.quoteIdentifier(part) : part,
      );
      return `CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX ${dialect.quoteIdentifier(index.name)} ON ${dialect.quoteTable(table)}${method ? ` USING ${(index.method ?? '').toLowerCase()}` : ''} (${parts.join(', ')})${index.where === undefined ? '' : ` WHERE ${index.where}`}`;
    },
  },
  mssql: {
    product: 'SQL Server',
    safety: 'It runs in one transaction: if a step fails, nothing has changed.',
    begin: ['BEGIN TRANSACTION'],
    commit: ['COMMIT TRANSACTION'],
    sequencesAreOwned: false,
    backup: (target, backup) => `SELECT * INTO ${backup} FROM ${target}`,
    restore: (_dialect, target, backup, columns, identity) => {
      const list = columns.join(', ');
      const insert = `INSERT INTO ${target} (${list}) SELECT ${list} FROM ${backup}`;
      return identity.length === 0
        ? [insert]
        : [`SET IDENTITY_INSERT ${target} ON`, insert, `SET IDENTITY_INSERT ${target} OFF`];
    },
    fixedIndex: (_dialect, _table, index) => describedIndex(index),
  },
  oracle: {
    product: 'Oracle',
    safety:
      'Oracle commits every DDL statement itself, so there is no rollback: if a step fails, the rows are still in the backup table, and the script can be continued by hand from there.',
    begin: [],
    commit: ['COMMIT'],
    sequencesAreOwned: false,
    backup: (target, backup) => `CREATE TABLE ${backup} AS SELECT * FROM ${target}`,
    restore: (dialect, target, backup, columns, identity) => {
      const list = columns.join(', ');
      return [
        `INSERT INTO ${target} (${list}) SELECT ${list} FROM ${backup}`,
        // The identity counter of the new table starts at 1: let it start past the rows.
        ...identity.map(
          (column) =>
            `ALTER TABLE ${target} MODIFY (${dialect.quoteIdentifier(column.name)} GENERATED BY DEFAULT AS IDENTITY (START WITH LIMIT VALUE))`,
        ),
      ];
    },
    fixedIndex: (_dialect, _table, index) => describedIndex(index),
  },
};
