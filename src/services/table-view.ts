// Opening a table from the tree: one page of rows plus how many there are in all.
// The SQL is built only through the driver's Dialect, never by string concatenation
// of user input (ARCHITECTURE.md §8).

import { errorMessage, toDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { TableRef } from '../core/model/objects';
import { syntaxOf } from '../core/sql/tokenizer';
import type { ResultColumn, Session } from '../drivers/driver';
import type { ConnectionManager, SessionTarget } from './connection-manager';
import type { MetadataCache } from './metadata-cache';
import { analyzeEditability } from './result-editability';
import type { ResultRow, ResultStore, ResultSummary } from './result-store';

/** Limits the user controls through settings (V1.25). */
export interface TableViewLimits {
  /** Rows one page of a table view holds. */
  pageSize(): number;
}

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

  constructor(deps: TableViewerDeps) {
    this.deps = deps;
    this.logger = deps.logger.child('table');
  }

  /** The owner key of the session a table view uses. */
  static owner(documentUri: string): string {
    return `table:${documentUri}`;
  }

  async open(request: OpenTableRequest): Promise<ResultSummary> {
    const documentUri = tableDocumentUri(request.target, request.table);
    const pageSize = Math.max(1, Math.trunc(this.deps.limits.pageSize()));
    const offset = Math.max(0, Math.trunc(request.offset ?? 0));
    const started = Date.now();
    // Kept outside the try so a failure before the SQL exists still has something
    // to show in the result tab.
    let sql = `SELECT * FROM ${request.table.name}`;
    try {
      const driver = await this.deps.manager.driverOf(request.target.connectionId);
      const quoted = driver.dialect.quoteTable(request.table);
      sql = driver.dialect.paginate(`SELECT * FROM ${quoted}`, pageSize, offset);
      const session = await this.deps.manager.acquire(
        TableViewer.owner(documentUri),
        request.target,
      );
      const { columns, rows } = await readAll(session, sql, pageSize);
      // Counting is a separate statement, and a failure there must not lose the page.
      const totalRows = request.totalRows ?? (await this.countRows(session, quoted));
      const edit = await analyzeEditability(
        {
          metadata: this.deps.cache.wrap(request.target.connectionId, session.metadata),
          syntax: syntaxOf(driver.id),
          schemas: driver.capabilities.schemas,
          logger: this.logger,
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
        page: {
          offset,
          pageSize,
          ...(totalRows === undefined ? {} : { totalRows }),
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
        page: { offset, pageSize },
      });
    }
  }

  /** `undefined` when the server would not count, e.g. no permission on the table. */
  private async countRows(session: Session, quotedTable: string): Promise<number | undefined> {
    try {
      const { rows } = await readAll(session, `SELECT COUNT(*) FROM ${quotedTable}`, 1);
      const value = rows[0]?.[0];
      if (typeof value === 'number') {
        return value;
      }
      if (typeof value === 'object' && value !== null && 'text' in value) {
        const parsed = Number(value.text);
        return Number.isFinite(parsed) ? parsed : undefined;
      }
      return undefined;
    } catch (error) {
      this.logger.debug(`Counting rows failed: ${errorMessage(error)}`);
      return undefined;
    }
  }
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
