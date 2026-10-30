// Exports every row of a query or table to a file as it streams from the server
// (V5.4), not just the rows the grid holds: CSV, JSON, SQL INSERT, Markdown or XLSX.
// The driver's back-pressure (D58) keeps memory flat however big the table is.

import { DbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type { TableRef } from '../core/model/objects';
import type { Dialect, ResultColumn, Session } from '../drivers/driver';
import { retainedBytes } from '../shared/binary-bytes';
import { cellJson, cellText, isNumericValue } from '../shared/cell-text';
import type { CellValue } from '../shared/cell-value';
import { toCsv } from '../shared/csv';
import { columnNames } from './column-names';
import { ConnectionManager, type SessionTarget } from './connection-manager';
import { PLACEHOLDER_TABLE } from './copy-as';
import { insertStatement, RowBatcher } from './dump-script';
import type { ExportFormat } from './result-export';
import type { DriverId } from '../shared/connection';
import { exactLiteralOf } from './sql-literal';
import {
  rowXml,
  SHEET_PATH,
  SHEET_TAIL,
  sheetHead,
  workbookParts,
  XLSX_MAX_ROWS,
  XlsxLimitError,
} from './xlsx';
import { ZipStream } from './zip-stream';
import { msg } from '../core/user-message';

/** Where the file goes: text for the text formats, bytes for XLSX. */
export interface ExportSink {
  write(text: string): Promise<void>;
  writeBytes(data: Uint8Array): Promise<void>;
}

export interface StreamExportRequest {
  readonly target: SessionTarget;
  /** The SELECT whose rows are written; it runs on a session of its own. */
  readonly sql: string;
  readonly format: ExportFormat;
  readonly sink: ExportSink;
  /** SQL format: the table the INSERT statements name; a placeholder otherwise. */
  readonly table?: TableRef;
  /** SQL format: rows go into identity columns, which PostgreSQL wants said. */
  readonly identity?: boolean;
  /** XLSX: the name of the sheet. */
  readonly sheetName?: string;
  readonly signal?: AbortSignal;
  /** Called after each batch with the rows written so far. */
  readonly onProgress?: (rows: number) => void;
}

export interface StreamExportReport {
  readonly rows: number;
  readonly durationMs: number;
}

export interface StreamExporterDeps {
  readonly manager: Pick<ConnectionManager, 'acquire' | 'release' | 'driverOf'>;
  readonly logger: Logger;
  readonly now?: () => number;
}

/** Writes rows in a format; `start` comes with the columns, `end` after the last row. */
interface RowWriter {
  start(columns: readonly ResultColumn[]): Promise<void>;
  rows(rows: readonly (readonly CellValue[])[]): Promise<void>;
  end(): Promise<void>;
}

let nextExport = 1;

export class StreamExporter {
  private readonly manager: StreamExporterDeps['manager'];
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: StreamExporterDeps) {
    this.manager = deps.manager;
    this.logger = deps.logger.child('export');
    this.now = deps.now ?? Date.now;
  }

  async export(request: StreamExportRequest): Promise<StreamExportReport> {
    const started = this.now();
    const { id: driver, dialect } = await this.manager.driverOf(request.target.connectionId);
    const owner = ConnectionManager.taskOwner(`export-${nextExport++}`);
    const session = await this.manager.acquire(owner, request.target);
    const cancel = (): void => {
      session.cancel().catch((error: unknown) => {
        this.logger.warn('Cancelling the export query failed', error);
      });
    };
    request.signal?.addEventListener('abort', cancel);
    try {
      const rows = await this.stream(session, writerFor(request, dialect, driver), request);
      this.logger.info(`Exported ${rows} rows as ${request.format}`);
      return { rows, durationMs: this.now() - started };
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw new DbError('cancelled', msg('The export was cancelled'));
      }
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', cancel);
      await this.manager.release(owner);
    }
  }

  private async stream(session: Session, writer: RowWriter, request: StreamExportRequest) {
    let rows = 0;
    let started = false;
    for await (const event of session.execute(request.sql)) {
      if (request.signal?.aborted === true) {
        throw new DbError('cancelled', msg('The export was cancelled'));
      }
      if (event.kind === 'columns') {
        if (started) {
          // A second result set (a CALL) does not fit one file of one table.
          break;
        }
        started = true;
        await writer.start(event.columns);
      } else if (event.kind === 'rows' && started) {
        await writer.rows(event.rows.map((row) => row.map(withAllBytes)));
        rows += event.rows.length;
        request.onProgress?.(rows);
      }
    }
    if (!started) {
      throw new DbError('unsupported', msg('The statement returns no rows to export'));
    }
    await writer.end();
    return rows;
  }
}

/** A binary value carries its whole content when the host still has it. */
function withAllBytes(cell: CellValue): CellValue {
  if (typeof cell === 'object' && cell !== null && cell.kind === 'binary') {
    const bytes = retainedBytes(cell);
    if (bytes !== undefined) {
      return {
        kind: 'binary',
        size: bytes.byteLength,
        preview: Buffer.from(bytes).toString('hex'),
      };
    }
  }
  return cell;
}

function writerFor(request: StreamExportRequest, dialect: Dialect, driver: DriverId): RowWriter {
  switch (request.format) {
    case 'csv':
      return csvWriter(request.sink);
    case 'json':
      return jsonWriter(request.sink);
    case 'markdown':
      return markdownWriter(request.sink);
    case 'sql':
      return sqlWriter(request, dialect, driver);
    case 'xlsx':
      return xlsxWriter(request);
  }
}

function csvWriter(sink: ExportSink): RowWriter {
  return {
    start: async (columns) => {
      await sink.write(toCsv([], { header: columnNames(columns) }));
    },
    rows: async (rows) => {
      await sink.write(toCsv(rows));
    },
    end: () => Promise.resolve(),
  };
}

/** An array of objects, one per line, exact numbers kept as text like the grid export. */
function jsonWriter(sink: ExportSink): RowWriter {
  let names: string[] = [];
  let first = true;
  return {
    start: async (columns) => {
      names = columnNames(columns);
      await sink.write('[');
    },
    rows: async (rows) => {
      const lines = rows.map((row) => {
        const record: Record<string, unknown> = {};
        names.forEach((name, index) => {
          record[name] = cellJson(row[index] ?? null);
        });
        const line = `${first ? '\n' : ',\n'}  ${JSON.stringify(record)}`;
        first = false;
        return line;
      });
      await sink.write(lines.join(''));
    },
    end: async () => {
      await sink.write(first ? ']\n' : '\n]\n');
    },
  };
}

/**
 * A GitHub table. Numeric columns are right-aligned, which the first batch decides:
 * the header goes out only once there is a batch to look at.
 */
function markdownWriter(sink: ExportSink): RowWriter {
  let names: string[] = [];
  let headed = false;
  const escape = (value: string): string =>
    value.replaceAll('|', '\\|').replace(/\r\n|\r|\n/gu, '<br>');
  const line = (cells: readonly string[]): string => `| ${cells.join(' | ')} |\n`;
  const head = async (rows: readonly (readonly CellValue[])[]): Promise<void> => {
    headed = true;
    const align = names.map((_name, index) => {
      const values = rows.map((row) => row[index] ?? null).filter((cell) => cell !== null);
      return values.length > 0 && values.every(isNumericValue) ? '---:' : '---';
    });
    await sink.write(line(names.map(escape)) + line(align));
  };
  return {
    start: (columns) => {
      names = columnNames(columns);
      return Promise.resolve();
    },
    rows: async (rows) => {
      if (!headed) {
        await head(rows);
      }
      await sink.write(
        rows
          .map((row) =>
            line(names.map((_n, i) => escape(cellText(row[i] ?? null, { nullText: 'NULL' })))),
          )
          .join(''),
      );
    },
    end: async () => {
      if (!headed) {
        await head([]);
      }
    },
  };
}

function sqlWriter(request: StreamExportRequest, dialect: Dialect, driver: DriverId): RowWriter {
  const batcher = new RowBatcher();
  let table = '';
  let columns: string[] = [];
  const flush = async (tuples: string[]): Promise<void> => {
    if (tuples.length > 0) {
      const sql = dialect.dump.insert(table, columns, tuples, request.identity === true);
      await request.sink.write(insertStatement(sql, driver));
    }
  };
  return {
    start: (resultColumns) => {
      table =
        request.table === undefined
          ? dialect.quoteIdentifier(PLACEHOLDER_TABLE)
          : dialect.quoteTable(request.table);
      columns = columnNames(resultColumns).map((name) => dialect.quoteIdentifier(name));
      return Promise.resolve();
    },
    rows: async (rows) => {
      for (const row of rows) {
        const tuple = `(${columns.map((_c, i) => exactLiteralOf(dialect, row[i] ?? null)).join(', ')})`;
        const full = batcher.add(tuple);
        if (full !== undefined) {
          await flush(full);
        }
      }
    },
    end: async () => {
      await flush(batcher.take());
    },
  };
}

/** Rows wait until this many are there, so the column widths have something to go by. */
const WIDTH_SAMPLE = 200;
/** Sheet text is compressed and written in parts of about this size. */
const SHEET_PART = 256 * 1024;

function xlsxWriter(request: StreamExportRequest): RowWriter {
  const zip = new ZipStream(async (data) => {
    await request.sink.writeBytes(data);
  });
  let names: string[] = [];
  let sample: (readonly CellValue[])[] | undefined = [];
  let sheet: { write(data: Uint8Array): Promise<void>; end(): Promise<void> } | undefined;
  let pending: string[] = [];
  let pendingChars = 0;
  let written = 0;
  const flush = async (): Promise<void> => {
    if (pending.length > 0 && sheet !== undefined) {
      await sheet.write(Buffer.from(pending.join(''), 'utf8'));
      pending = [];
      pendingChars = 0;
    }
  };
  const add = async (text: string): Promise<void> => {
    pending.push(text);
    pendingChars += text.length;
    if (pendingChars >= SHEET_PART) {
      await flush();
    }
  };
  const put = async (rows: readonly (readonly CellValue[])[]): Promise<void> => {
    for (const row of rows) {
      written += 1;
      if (written + 1 > XLSX_MAX_ROWS) {
        throw new XlsxLimitError(msg('Excel holds at most {0} data rows', XLSX_MAX_ROWS - 1));
      }
      await add(rowXml(names.length, row, written + 1));
    }
  };
  /** Once the widths are known, the sheet starts and the sample goes in first. */
  const open = async (): Promise<void> => {
    for (const part of workbookParts(request.sheetName)) {
      await zip.addFile(part.name, Buffer.from(part.xml, 'utf8'));
    }
    sheet = await zip.beginFile(SHEET_PATH);
    const rows = sample ?? [];
    sample = undefined;
    await add(sheetHead({ header: names, rows }));
    await put(rows);
  };
  return {
    start: (columns) => {
      names = columnNames(columns);
      return Promise.resolve();
    },
    rows: async (rows) => {
      if (sample !== undefined) {
        sample.push(...rows);
        if (sample.length < WIDTH_SAMPLE) {
          return;
        }
        await open();
        return;
      }
      await put(rows);
    },
    end: async () => {
      if (sample !== undefined) {
        await open();
      }
      await add(SHEET_TAIL);
      await flush();
      await sheet?.end();
      await zip.finish();
    },
  };
}
