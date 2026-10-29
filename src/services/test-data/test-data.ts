// Test data for a table (V5.5): what each column gets, the rows a seed gives, and
// getting them into the table — through the importer, so values pass the same type
// rules as a file import and go in batches inside one transaction.

import type { TableRef, TableStructure } from '../../core/model/objects';
import type { Dialect, Session } from '../../drivers/driver';
import { cellText } from '../../shared/cell-text';
import type { CellValue } from '../../shared/cell-value';
import { RowBatcher } from '../dump-script';
import type { SourceRecord } from '../import/import-source';
import { convertValue } from '../import/import-values';
import type { ImportColumn } from '../import/table-import';
import { exactLiteralOf } from '../sql-literal';
import { type PlanColumn, suggestGenerator, typeSettings } from './column-plan';
import { generateValue, type GeneratorKind, type GeneratorSettings, Random } from './generators';

/** How many existing keys of a referenced table are offered to the reference generator. */
export const REFERENCE_SAMPLE = 1000;

/** What the user chose for one column. */
export interface ColumnChoice {
  readonly generator: GeneratorKind;
  /** Share of NULLs, 0…100; only nullable columns get any. */
  readonly nullPercent: number;
}

/** The columns of a table as the generator sees them. */
export function planColumns(structure: TableStructure): PlanColumn[] {
  const singleKeys = new Set(
    [
      structure.primaryKey,
      ...structure.indexes.filter((index) => index.unique).map((index) => index.columns),
    ]
      .filter((columns) => columns.length === 1)
      .map((columns) => columns[0] ?? ''),
  );
  return structure.columns.map((column) => {
    const key = structure.foreignKeys.find(
      (foreign) => foreign.columns.length === 1 && foreign.columns[0] === column.name,
    );
    return {
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable,
      autoIncrement: column.autoIncrement,
      generated: column.generated,
      unique: singleKeys.has(column.name),
      ...(key === undefined
        ? {}
        : {
            reference: {
              table: [key.target.schema, key.target.name].filter((p) => p !== undefined).join('.'),
              column: key.targetColumns[0] ?? '',
            },
          }),
    };
  });
}

/** Everything a run needs to know beyond the choices: keys to point at, where sequences start. */
export interface GenerationContext {
  /** Existing values of each referenced column, by column name. */
  readonly references: ReadonlyMap<string, readonly string[]>;
  /** The first value of each sequence column, past what the table holds. */
  readonly starts: ReadonlyMap<string, number>;
}

/** Reads the existing keys references draw from and where each sequence starts. */
export async function loadContext(
  session: Session,
  dialect: Dialect,
  table: TableRef,
  structure: TableStructure,
  choices: readonly ColumnChoice[],
): Promise<GenerationContext> {
  const references = new Map<string, string[]>();
  const starts = new Map<string, number>();
  for (const [index, column] of structure.columns.entries()) {
    const choice = choices[index];
    if (choice?.generator === 'reference') {
      const key = structure.foreignKeys.find(
        (foreign) => foreign.columns.length === 1 && foreign.columns[0] === column.name,
      );
      if (key !== undefined) {
        const target = dialect.quoteIdentifier(key.targetColumns[0] ?? column.name);
        const sql = dialect.paginate(
          `SELECT DISTINCT ${target} FROM ${dialect.quoteTable(key.target)} WHERE ${target} IS NOT NULL`,
          REFERENCE_SAMPLE,
          0,
        );
        references.set(
          column.name,
          (await firstColumn(session, sql)).map((cell) => cellText(cell)),
        );
      }
    } else if (choice?.generator === 'sequence') {
      const name = dialect.quoteIdentifier(column.name);
      const [highest] = await firstColumn(
        session,
        `SELECT MAX(${name}) FROM ${dialect.quoteTable(table)}`,
      );
      const top = highest === null || highest === undefined ? 0 : Number(cellText(highest));
      starts.set(column.name, Number.isFinite(top) ? top + 1 : 1);
    }
  }
  return { references, starts };
}

/** The choices the columns start with: the suggested generator and no NULLs. */
export function suggestChoices(columns: readonly PlanColumn[]): ColumnChoice[] {
  return columns.map((column) => ({ generator: suggestGenerator(column), nullPercent: 0 }));
}

/** Generator settings per column, from its type, the choice and the context. */
export function columnSettings(
  columns: readonly PlanColumn[],
  choices: readonly ColumnChoice[],
  context: GenerationContext,
): GeneratorSettings[] {
  return columns.map((column, index) => {
    const generator = choices[index]?.generator ?? 'default';
    const base = typeSettings(column, generator);
    const choicesOf = context.references.get(column.name);
    const start = context.starts.get(column.name);
    return {
      ...base,
      ...(generator === 'reference' && choicesOf !== undefined ? { choices: choicesOf } : {}),
      ...(start === undefined ? {} : { start }),
    };
  });
}

/** Rows as text per column (null for NULL), the same for the same seed. */
export function* generateRows(
  settings: readonly GeneratorSettings[],
  choices: readonly ColumnChoice[],
  columns: readonly PlanColumn[],
  count: number,
  seed: number,
): Generator<(string | null)[]> {
  const random = new Random(seed);
  for (let row = 0; row < count; row += 1) {
    yield settings.map((setting, index) => {
      const percent = choices[index]?.nullPercent ?? 0;
      const nullable = columns[index]?.nullable === true;
      // Drawn for every column, so the other values do not change with the NULL share.
      const roll = random.next() * 100;
      const value = generateValue(setting, random, row);
      return nullable && roll < percent ? null : value;
    });
  }
}

/** The columns that get values: everything not left to the database. */
export function filledColumns(
  columns: readonly PlanColumn[],
  choices: readonly ColumnChoice[],
): ImportColumn[] {
  return columns.flatMap((column, index) => {
    const generator = choices[index]?.generator ?? 'default';
    if (generator === 'default' || column.generated) {
      return [];
    }
    return [
      {
        name: column.name,
        dataType: column.dataType,
        source: index,
        autoIncrement: column.autoIncrement,
        sequenced: column.autoIncrement,
      },
    ];
  });
}

/** Generated rows as import records, numbered from 1. */
export async function* asRecords(rows: Iterable<(string | null)[]>): AsyncGenerator<SourceRecord> {
  let line = 0;
  for (const values of rows) {
    line += 1;
    yield { line, values };
    if (line % 500 === 0) {
      // Let the host breathe between batches of a million-row run.
      await Promise.resolve();
    }
  }
}

/**
 * The rows as INSERT statements, for the editor. A value that does not fit its
 * column (a reference with nothing to point at) is written as NULL with a comment.
 */
export function insertScript(
  dialect: Dialect,
  table: TableRef,
  columns: readonly ImportColumn[],
  rows: Iterable<(string | null)[]>,
): string {
  const quotedTable = dialect.quoteTable(table);
  const quoted = columns.map((column) => dialect.quoteIdentifier(column.name));
  const identity = columns.some((column) => column.autoIncrement);
  const statements: string[] = [];
  const batcher = new RowBatcher();
  const flush = (tuples: string[]): void => {
    if (tuples.length > 0) {
      statements.push(`${dialect.dump.insert(quotedTable, quoted, tuples, identity)};`);
    }
  };
  for (const values of rows) {
    const literals = columns.map((column) => {
      const converted = convertValue(values[column.source] ?? null, column.dataType, {
        emptyIsNull: false,
        nullText: '',
      });
      const cell: CellValue = converted.ok ? converted.value : null;
      return exactLiteralOf(dialect, cell);
    });
    const full = batcher.add(`(${literals.join(', ')})`);
    if (full !== undefined) {
      flush(full);
    }
  }
  flush(batcher.take());
  return `${statements.join('\n\n')}\n`;
}

async function firstColumn(session: Session, sql: string): Promise<CellValue[]> {
  const cells: CellValue[] = [];
  for await (const event of session.execute(sql)) {
    if (event.kind === 'rows') {
      cells.push(...event.rows.map((row) => row[0] ?? null));
    }
  }
  return cells;
}
