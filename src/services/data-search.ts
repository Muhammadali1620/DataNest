// "Find Data…" (V10.2.6): which tables of a database or schema hold a text, and in which
// columns. Every table with text columns is asked once — one statement counting the
// matching rows per column — and a hit opens the table filtered to those rows. The text
// goes in as a literal of the dialect (D103), with LIKE's own characters escaped.

import { errorMessage } from '../core/errors';
import type { ObjectScope, TableRef } from '../core/model/objects';
import type { Dialect, MetadataReader, Session } from '../drivers/driver';
import { inputKindOf } from '../shared/cell-input';
import type { SqlDriverId } from '../shared/connection';

/** Longest text searched for; a search box, not a document. */
export const MAX_SEARCH_TEXT = 500;

/** Text columns searched in one table at most, so a statement stays a sane size. */
export const MAX_SEARCHED_COLUMNS = 200;

export interface DataSearchHit {
  readonly table: TableRef;
  /** Rows with the text in any searched column. */
  readonly rows: number;
  /** The columns that hold it, with how many rows each. */
  readonly columns: readonly { readonly name: string; readonly rows: number }[];
  /** The condition that finds those rows, to open the table filtered by it. */
  readonly where: string;
}

export interface DataSearchReport {
  readonly hits: readonly DataSearchHit[];
  /** Tables looked through, with or without text columns. */
  readonly tables: number;
  /** Tables the server refused to read, with why. */
  readonly failures: readonly { readonly table: string; readonly error: string }[];
  readonly cancelled: boolean;
}

export interface DataSearchRequest {
  readonly session: Pick<Session, 'execute'> & { readonly metadata: MetadataReader };
  readonly dialect: Dialect;
  readonly driver: SqlDriverId;
  readonly scope: ObjectScope;
  readonly text: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (done: number, total: number, table: string) => void;
}

/**
 * "Contains the text" as a LIKE pattern: `%`, `_` and the escape character `!` escaped,
 * and on SQL Server `[` too, which opens a set of characters there. Oracle refuses an
 * escape before anything else, so nothing more is escaped.
 */
export function likePattern(text: string, driver: SqlDriverId): string {
  const special = driver === 'mssql' ? /[!%_[]/gu : /[!%_]/gu;
  return `%${text.replace(special, (char) => `!${char}`)}%`;
}

/**
 * True when "contains" works on the column by LIKE: text kinds the server compares
 * as text. Binary, numbers, dates and JSON are left out; their text is not what is stored.
 */
export function searchableColumn(dataType: string, driver: SqlDriverId): boolean {
  if (inputKindOf(dataType, driver) !== 'text' && inputKindOf(dataType, driver) !== 'enum') {
    return false;
  }
  // Spatial, XML and arrays read as text, but are not what a person typed.
  return !/^(geometry|geography|point|linestring|polygon|multi|geomcollection|xml|tsvector|uuid)|\[\]$/iu.test(
    dataType.trim(),
  );
}

/** The condition "this column contains the text", without regard to case, per server. */
export function containsCondition(
  column: string,
  text: string,
  dialect: Dialect,
  driver: SqlDriverId,
): string {
  const name = dialect.quoteIdentifier(column);
  const pattern = dialect.literal(likePattern(text, driver));
  switch (driver) {
    case 'postgres':
      return `${name}::text ILIKE ${pattern} ESCAPE '!'`;
    case 'oracle':
      return `UPPER(${name}) LIKE UPPER(${pattern}) ESCAPE '!'`;
    case 'clickhouse':
      // No escaping needed: a plain search for the text, in UTF-8, ignoring case.
      return `positionCaseInsensitiveUTF8(toString(${name}), ${dialect.literal(text)}) > 0`;
    case 'mysql':
    case 'sqlite':
    case 'mssql':
      // MySQL and SQL Server compare ignoring case by their default collations, SQLite in ASCII.
      return `${name} LIKE ${pattern} ESCAPE '!'`;
  }
}

function count(cell: unknown): number {
  const value =
    typeof cell === 'object' && cell !== null && 'text' in cell
      ? Number((cell as { text: string }).text)
      : Number(cell ?? 0);
  return Number.isFinite(value) ? value : 0;
}

export async function searchData(request: DataSearchRequest): Promise<DataSearchReport> {
  const { session, dialect, driver, scope } = request;
  const text = request.text.slice(0, MAX_SEARCH_TEXT);
  const tables = (await session.metadata.listTables(scope)).filter(
    (table) => table.kind === 'table',
  );
  const hits: DataSearchHit[] = [];
  const failures: { table: string; error: string }[] = [];
  // A call, so a cancel that came while a statement ran is seen.
  const aborted = (): boolean => request.signal?.aborted === true;
  for (const [index, info] of tables.entries()) {
    if (aborted()) {
      return { hits, tables: index, failures, cancelled: true };
    }
    request.onProgress?.(index, tables.length, info.name);
    const table: TableRef = { ...scope, name: info.name };
    try {
      const columns = (await session.metadata.listColumns(table))
        .filter((column) => searchableColumn(column.dataType, driver))
        .slice(0, MAX_SEARCHED_COLUMNS)
        .map((column) => column.name);
      if (columns.length === 0) {
        continue;
      }
      const conditions = columns.map((column) => containsCondition(column, text, dialect, driver));
      const where = conditions.join(' OR ');
      const sql = `SELECT COUNT(*), ${conditions
        .map((condition) => `SUM(CASE WHEN ${condition} THEN 1 ELSE 0 END)`)
        .join(', ')} FROM ${dialect.quoteTable(table)} WHERE ${where}`;
      let row: readonly unknown[] = [];
      for await (const event of session.execute(sql)) {
        if (event.kind === 'rows' && event.rows[0] !== undefined) {
          row = event.rows[0];
        }
      }
      const rows = count(row[0]);
      if (rows > 0) {
        hits.push({
          table,
          rows,
          columns: columns
            .map((name, position) => ({ name, rows: count(row[position + 1]) }))
            .filter((column) => column.rows > 0),
          where,
        });
      }
    } catch (error) {
      if (aborted()) {
        return { hits, tables: index, failures, cancelled: true };
      }
      failures.push({ table: info.name, error: errorMessage(error) });
    }
  }
  return { hits, tables: tables.length, failures, cancelled: false };
}
