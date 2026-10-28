// The table designer's model: what the page edits and the host turns into DDL.
// Shared by both sides (D27), so the page and the host check a design by the same
// rules and never disagree about what can be saved.

import type { DriverId } from './connection';

export const DESIGN_LIMITS = {
  name: 256,
  type: 200,
  length: 1000,
  defaultValue: 4000,
  comment: 2000,
  columns: 1000,
} as const;

export interface ColumnDesign {
  /** Stable within one designer session, so a renamed column is still the same one. */
  readonly id: string;
  /** The column's name in the database before this edit; absent for a new column. */
  readonly original?: string;
  readonly name: string;
  /** The type without its length: `varchar`, `int unsigned`, `timestamp with time zone`. */
  readonly type: string;
  /** What goes in parentheses after the type: `255`, `10,2`, `'a','b'`; empty for none. */
  readonly length: string;
  readonly nullable: boolean;
  /** The default as a SQL expression (`0`, `'new'`, `CURRENT_TIMESTAMP`); empty for none. */
  readonly defaultValue: string;
  readonly autoIncrement: boolean;
  readonly primaryKey: boolean;
  readonly comment: string;
}

export interface TableDesign {
  readonly name: string;
  readonly comment: string;
  readonly columns: readonly ColumnDesign[];
}

/** What a driver's designer can do, so the page shows only what will work. */
export interface DesignerFeatures {
  readonly columnComments: boolean;
  readonly tableComment: boolean;
  /** Type names offered while typing; any other text is accepted too. */
  readonly types: readonly string[];
}

/** Words that may follow a length: `decimal(10,2) unsigned`, `time(3) with time zone`. */
const TYPE_SUFFIX = /\s+(unsigned|zerofill|with|without|character|charset|collate|array)\b.*$/i;

/** `varchar` + `255` → `varchar(255)`; a suffix stays after the parentheses. */
export function composeType(type: string, length: string): string {
  const base = type.trim();
  const inner = length.trim();
  if (inner === '') {
    return base;
  }
  const suffix = TYPE_SUFFIX.exec(base);
  if (suffix === null) {
    return `${base}(${inner})`;
  }
  return `${base.slice(0, suffix.index)}(${inner})${base.slice(suffix.index)}`;
}

/** The reverse of `composeType`: `decimal(10,2) unsigned` → `decimal unsigned` + `10,2`. */
export function splitType(full: string): { type: string; length: string } {
  const text = full.trim();
  const open = text.indexOf('(');
  if (open === -1) {
    return { type: text, length: '' };
  }
  const close = matchingParen(text, open);
  if (close === -1) {
    return { type: text, length: '' };
  }
  const before = text.slice(0, open).trimEnd();
  const after = text.slice(close + 1).trim();
  return {
    type: after === '' ? before : `${before} ${after}`,
    length: text.slice(open + 1, close).trim(),
  };
}

/** The closing parenthesis of the one at `open`, skipping quoted enum values. */
function matchingParen(text: string, open: number): number {
  let depth = 0;
  let quoted = false;
  for (let index = open; index < text.length; index++) {
    const char = text[index];
    if (char === "'") {
      quoted = !quoted;
    } else if (!quoted && char === '(') {
      depth++;
    } else if (!quoted && char === ')') {
      depth--;
      if (depth === 0) {
        return index;
      }
    }
  }
  return -1;
}

export type DesignProblem =
  | { readonly kind: 'table-name' }
  | { readonly kind: 'no-columns' }
  | { readonly kind: 'column-name'; readonly column: string }
  | { readonly kind: 'duplicate-column'; readonly column: string }
  | { readonly kind: 'column-type'; readonly column: string }
  | {
      readonly kind: 'auto-increment';
      readonly column: string;
      /** `type`: not an integer type; `key`: not (the only) primary key; `several`; `default`. */
      readonly reason: 'type' | 'key' | 'several' | 'default';
    };

const INTEGER_TYPES: Readonly<Record<DriverId, ReadonlySet<string>>> = {
  mysql: new Set([
    'tinyint',
    'smallint',
    'mediumint',
    'int',
    'integer',
    'bigint',
    'tinyint unsigned',
    'smallint unsigned',
    'mediumint unsigned',
    'int unsigned',
    'integer unsigned',
    'bigint unsigned',
  ]),
  postgres: new Set(['smallint', 'integer', 'int', 'bigint', 'int2', 'int4', 'int8']),
  // Only INTEGER PRIMARY KEY is the rowid; INT or BIGINT would not auto-number.
  sqlite: new Set(['integer']),
};

/**
 * Everything that stops a design from being saved, with the column it concerns
 * (by id). Names are compared without case: MySQL and SQLite treat `Id` and `id` as
 * one column, and a design that only PostgreSQL accepts helps nobody.
 */
export function designProblems(design: TableDesign, driver: DriverId): DesignProblem[] {
  const problems: DesignProblem[] = [];
  if (design.name.trim() === '') {
    problems.push({ kind: 'table-name' });
  }
  if (design.columns.length === 0) {
    problems.push({ kind: 'no-columns' });
  }
  const seen = new Set<string>();
  for (const column of design.columns) {
    const name = column.name.trim();
    if (name === '') {
      problems.push({ kind: 'column-name', column: column.id });
    } else if (seen.has(name.toLowerCase())) {
      problems.push({ kind: 'duplicate-column', column: column.id });
    }
    seen.add(name.toLowerCase());
    if (column.type.trim() === '') {
      problems.push({ kind: 'column-type', column: column.id });
    }
  }
  problems.push(...autoIncrementProblems(design, driver));
  return problems;
}

function autoIncrementProblems(design: TableDesign, driver: DriverId): DesignProblem[] {
  const problems: DesignProblem[] = [];
  const auto = design.columns.filter((column) => column.autoIncrement);
  const keys = design.columns.filter((column) => column.primaryKey);
  for (const [index, column] of auto.entries()) {
    const type = column.type.trim().toLowerCase().replace(/\s+/g, ' ');
    if (driver !== 'postgres' && index > 0) {
      problems.push({ kind: 'auto-increment', column: column.id, reason: 'several' });
    } else if (!INTEGER_TYPES[driver].has(type)) {
      problems.push({ kind: 'auto-increment', column: column.id, reason: 'type' });
    } else if (
      (driver === 'mysql' && !column.primaryKey) ||
      (driver === 'sqlite' && (!column.primaryKey || keys.length !== 1))
    ) {
      problems.push({ kind: 'auto-increment', column: column.id, reason: 'key' });
    } else if (driver === 'postgres' && column.defaultValue.trim() !== '') {
      // An identity column numbers itself; PostgreSQL refuses a default next to it.
      problems.push({ kind: 'auto-increment', column: column.id, reason: 'default' });
    }
  }
  return problems;
}

/** The column every new table starts with: an auto-numbered primary key. */
export function newTableDesign(driver: DriverId, name = ''): TableDesign {
  return {
    name,
    comment: '',
    columns: [
      {
        id: 'new-1',
        name: 'id',
        type: driver === 'mysql' ? 'int' : 'integer',
        length: '',
        nullable: false,
        defaultValue: '',
        autoIncrement: true,
        primaryKey: true,
        comment: '',
      },
    ],
  };
}
