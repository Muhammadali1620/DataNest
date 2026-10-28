// Opening a table from the tree: one page of rows plus how many there are in all.
// The SQL is built only through the driver's Dialect, never by string concatenation
// of user input (ARCHITECTURE.md §8).

import { errorMessage, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { TableRef } from '../core/model/objects';
import { syntaxOf } from '../core/sql/tokenizer';
import type { CellValue } from '../shared/cell-value';
import type { Dialect, ResultColumn, Session } from '../drivers/driver';
import type { ConnectionManager, SessionTarget } from './connection-manager';
import type { MetadataCache } from './metadata-cache';
import { analyzeEditability } from './result-editability';
import { buildOrderBy, buildWhere, type TableSort } from './table-filter-sql';
import type { ResultRow, ResultStore, ResultSummary } from './result-store';
import { isEmptyFilter, type TableFilter } from '../shared/table-filter';

/** Limits the user controls through settings (V1.25). */
export interface TableViewLimits {
  /** Rows one page of a table view holds. */
  pageSize(): number;
}

/**
 * Up to this many rows a table is simply counted; beyond it the server's estimate is
 * shown first, because COUNT(*) on a big table can take minutes.
 */
export const EXACT_COUNT_LIMIT = 100_000;

export interface TableViewerDeps {
  readonly manager: ConnectionManager;
  readonly results: ResultStore;
  readonly cache: MetadataCache;
  readonly limits: TableViewLimits;
  readonly logger: Logger;
}

export interface OpenTableRequest {
  readonly target: SessionTarget;
  readonly table: TableRef;
  /** Rows to skip; the first page by default. */
  readonly offset?: number;
  /** Known row count, so paging does not count again. */
  readonly totalRows?: number;
  /** True when `totalRows` is the server's estimate, not a count. */
  readonly approximate?: boolean;
  /** Rows per page; the setting's value by default. */
  readonly pageSize?: number;
  /** Count exactly even where an estimate would do. */
  readonly exactCount?: boolean;
  /** Server-side conditions; the count then covers only the matching rows. */
  readonly filter?: TableFilter;
  /** Server-side order. */
  readonly sort?: TableSort;
}

/** What `reload` may change about an open table view; absent fields stay as they are. */
export interface TableChange {
  readonly offset?: number;
  /** Rows per page; the view then starts again from the first page. */
  readonly pageSize?: number;
  /** Replace an estimated row count with a real one. */
  readonly exactCount?: boolean;
  /** `null` removes the filter. */
  readonly filter?: TableFilter | null;
  /** `null` restores the table's own order. */
  readonly sort?: TableSort | null;
}

/** A table view is its own "document", so its results never mix with an editor's. */
export function tableDocumentUri(target: SessionTarget, table: TableRef): string {
  const parts = [
    target.connectionId,
    table.database ?? target.database ?? '',
    table.schema ?? '',
    table.name,
  ];
  return `datanest-table:${parts.map((part) => encodeURIComponent(part)).join('/')}`;
}

/** Reads one page of a table and stores it like any other result. */
export class TableViewer {
  private readonly deps: TableViewerDeps;
  private readonly logger: Logger;
  /** What each open table view shows, so paging, filtering and sorting can repeat it. */
  private readonly views = new Map<string, OpenTableRequest>();

  constructor(deps: TableViewerDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('table');
  }

  /** The owner key of the session a table view uses. */
  static owner(documentUri: string): string {
    return `table:${documentUri}`;
  }

  /**
   * Re-reads the table view that owns a result, with some of its settings changed.
   * A new filter starts at the first page and counts again; a new sort or page keeps
   * the count it has. Returns false when the result is not a table view.
   */
  async reload(resultId: string, change: TableChange): Promise<boolean> {
    const summary = this.deps.results.get(resultId);
    const request = summary === undefined ? undefined : this.views.get(summary.documentUri);
    if (summary?.page === undefined || request === undefined) {
      return false;
    }
    const filter = change.filter === undefined ? request.filter : (change.filter ?? undefined);
    const sort = change.sort === undefined ? request.sort : (change.sort ?? undefined);
    const refiltered = change.filter !== undefined;
    const total = refiltered || change.exactCount === true ? undefined : summary.page.totalRows;
    const resorted = change.sort !== undefined;
    const pageSize = change.pageSize ?? request.pageSize;
    await this.open({
      target: request.target,
      table: request.table,
      offset:
        refiltered || resorted || change.pageSize !== undefined
          ? 0
          : (change.offset ?? summary.page.offset),
      ...(total === undefined ? {} : { totalRows: total }),
      ...(total !== undefined && summary.page.approximate === true ? { approximate: true } : {}),
      ...(change.exactCount === true ? { exactCount: true } : {}),
      ...(pageSize === undefined ? {} : { pageSize }),
      ...(filter === undefined ? {} : { filter }),
      ...(sort === undefined ? {} : { sort }),
    });
    return true;
  }

  async open(request: OpenTableRequest): Promise<ResultSummary> {
    const documentUri = tableDocumentUri(request.target, request.table);
    const filter = isEmptyFilter(request.filter) ? undefined : request.filter;
    this.views.set(documentUri, {
      target: request.target,
      table: request.table,
      ...(filter === undefined ? {} : { filter }),
      ...(request.sort === undefined ? {} : { sort: request.sort }),
      ...(request.pageSize === undefined ? {} : { pageSize: request.pageSize }),
    });
    const pageSize = Math.max(1, Math.trunc(request.pageSize ?? this.deps.limits.pageSize()));
    const offset = Math.max(0, Math.trunc(request.offset ?? 0));
    const started = Date.now();
    // Kept outside the try so a failure before the SQL exists still has something
    // to show in the result tab.
    let sql = `SELECT * FROM ${request.table.name}`;
    try {
      const driver = await this.deps.manager.driverOf(request.target.connectionId);
      const quoted = driver.dialect.quoteTable(request.table);
      const where = buildWhere(driver.dialect, driver.id, filter);
      const orderBy = buildOrderBy(driver.dialect, request.sort);
      const whereSql = where === undefined ? '' : ` WHERE ${where}`;
      sql = driver.dialect.paginate(
        `SELECT * FROM ${quoted}${whereSql}${orderBy === undefined ? '' : ` ORDER BY ${orderBy}`}`,
        pageSize,
        offset,
      );
      const session = await this.deps.manager.acquire(
        TableViewer.owner(documentUri),
        request.target,
      );
      const { columns, rows } = await readAll(session, sql, pageSize);
      // Counting is a separate statement, and a failure there must not lose the page.
      const counted =
        request.totalRows === undefined
          ? await this.total(session, driver.dialect, request, quoted, whereSql)
          : { totalRows: request.totalRows, approximate: request.approximate === true };
      const totalRows = counted.totalRows;
      const edit = await analyzeEditability(
        {
          metadata: this.deps.cache.wrap(request.target.connectionId, session.metadata),
          syntax: syntaxOf(driver.id),
          schemas: driver.capabilities.schemas,
          logger: this.logger,
          readOnly: this.deps.manager.isReadOnly(request.target.connectionId),
        },
        `SELECT * FROM ${quoted}`,
        columns.map((column) => column.name),
      );
      return this.deps.results.add({
        documentUri,
        statement: sql,
        statementStart: 0,
        origin: { target: request.target, owner: TableViewer.owner(documentUri) },
        columns,
        rows,
        truncated: false,
        durationMs: Date.now() - started,
        edit,
        ...(filter === undefined ? {} : { filter }),
        ...(sortOf(request.sort, columns) === undefined
          ? {}
          : { sort: sortOf(request.sort, columns) }),
        page: {
          offset,
          pageSize,
          ...(totalRows === undefined ? {} : { totalRows }),
          ...(counted.approximate ? { approximate: true } : {}),
        },
      });
    } catch (error) {
      const dbError = toDbError(error);
      this.logger.warn(`Could not open ${request.table.name}: ${dbError.message}`, dbError);
      return this.deps.results.add({
        documentUri,
        statement: sql,
        statementStart: 0,
        columns: [],
        rows: [],
        truncated: false,
        durationMs: Date.now() - started,
        error: { code: dbError.code, message: dbError.message },
        ...(filter === undefined ? {} : { filter }),
        page: { offset, pageSize },
      });
    }
  }

  /**
   * The row count to show. A big unfiltered table gets the server's estimate (marked
   * approximate) instead of a slow COUNT(*); everything else is counted exactly.
   */
  private async total(
    session: Session,
    dialect: Dialect,
    request: OpenTableRequest,
    quoted: string,
    whereSql: string,
  ): Promise<{ totalRows: number | undefined; approximate: boolean }> {
    if (whereSql === '' && request.exactCount !== true && dialect.estimateRowsSql !== undefined) {
      const estimate = await this.estimateRows(session, dialect.estimateRowsSql(request.table));
      if (estimate !== undefined && estimate > EXACT_COUNT_LIMIT) {
        return { totalRows: estimate, approximate: true };
      }
    }
    return { totalRows: await this.countRows(session, `${quoted}${whereSql}`), approximate: false };
  }

  /** The estimate, or undefined when the server has none (NULL, -1) or the query fails. */
  private async estimateRows(session: Session, sql: string): Promise<number | undefined> {
    try {
      const { rows } = await readAll(session, sql, 1);
      const parsed = numberOf(rows[0]?.[0]);
      return parsed !== undefined && parsed >= 0 ? Math.round(parsed) : undefined;
    } catch (error) {
      this.logger.debug(`Estimating rows failed: ${errorMessage(error)}`);
      return undefined;
    }
  }

  /** `undefined` when the server would not count, e.g. no permission on the table. */
  private async countRows(session: Session, quotedTable: string): Promise<number | undefined> {
    try {
      const { rows } = await readAll(session, `SELECT COUNT(*) FROM ${quotedTable}`, 1);
      return numberOf(rows[0]?.[0]);
    } catch (error) {
      this.logger.debug(`Counting rows failed: ${errorMessage(error)}`);
      return undefined;
    }
  }
}

/** The sort as the grid shows it: a column index in the result. */
function sortOf(
  sort: TableSort | undefined,
  columns: readonly ResultColumn[],
): { column: number; direction: 'asc' | 'desc' } | undefined {
  if (sort === undefined) {
    return undefined;
  }
  const column = columns.findIndex((candidate) => candidate.name === sort.column);
  return column < 0 ? undefined : { column, direction: sort.direction };
}

/** A count as the drivers return it: a number, or text for values beyond 2^53. */
function numberOf(value: CellValue | undefined): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (typeof value === 'object' && value !== null && 'text' in value) {
    const parsed = Number(value.text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

interface Collected {
  readonly columns: readonly ResultColumn[];
  readonly rows: ResultRow[];
}

async function readAll(session: Session, sql: string, rowLimit: number): Promise<Collected> {
  let columns: readonly ResultColumn[] = [];
  const rows: ResultRow[] = [];
  for await (const event of session.execute(sql, { rowLimit })) {
    if (event.kind === 'columns') {
      columns = event.columns;
    } else if (event.kind === 'rows') {
      rows.push(...event.rows);
    }
  }
  return { columns, rows };
}
