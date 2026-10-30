// Copies tables from one connection to another (V5.6), between databases of any
// kind. The source is read in one snapshot; on the target each table is created from
// its structure translated by the target's dialect, its rows stream across with
// their values adjusted, and foreign keys follow where they can.

import { DbError, errorMessage } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import type { ColumnDetail, ObjectScope, TableRef, TableStructure } from '../../core/model/objects';
import type { Dialect, Driver, Session } from '../../drivers/driver';
import {
  type ColumnDesign,
  composeType,
  designProblems,
  NO_BACKGROUND,
  type TableDesign,
} from '../../shared/table-design';
import { ConnectionManager, type SessionTarget } from '../connection-manager';
import { RowBatcher } from '../dump-script';
import { exactLiteralOf } from '../sql-literal';
import { designFromStructure } from '../table-structure';
import { transferValue } from './transfer-values';
import { mapColumnType, mapDefault, type NeutralType, neutralType } from './type-map';
import { msg } from '../../core/user-message';

export type TransferContent = 'all' | 'structure' | 'data';
/** What happens to a table the target already has. */
export type ExistingTable = 'append' | 'replace' | 'skip';

export interface TransferEnd {
  readonly target: SessionTarget;
  readonly scope: ObjectScope;
}

export interface TransferRequest {
  readonly source: TransferEnd;
  readonly destination: TransferEnd;
  readonly tables: readonly string[];
  readonly content: TransferContent;
  readonly existing: ExistingTable;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: TransferProgress) => void;
}

export interface TransferProgress {
  readonly table: string;
  readonly rows: number;
  readonly tablesDone: number;
  readonly tablesTotal: number;
}

/** Something about a table the user should know, though it was copied. */
export type TransferNote =
  | { readonly kind: 'default-dropped'; readonly column: string; readonly expression: string }
  | { readonly kind: 'auto-increment-dropped'; readonly column: string }
  | { readonly kind: 'key-dropped'; readonly key: string; readonly target: string }
  | { readonly kind: 'generated-skipped'; readonly column: string }
  | { readonly kind: 'columns-skipped'; readonly columns: readonly string[] };

export interface TableTransfer {
  readonly table: string;
  readonly outcome: 'copied' | 'skipped' | 'failed';
  readonly created: boolean;
  readonly rows: number;
  readonly notes: readonly TransferNote[];
  readonly error?: string;
}

export interface TransferReport {
  readonly outcome: 'done' | 'cancelled';
  readonly tables: readonly TableTransfer[];
  readonly rows: number;
  readonly durationMs: number;
}

export interface TableTransferDeps {
  readonly manager: Pick<ConnectionManager, 'acquire' | 'release' | 'driverOf'>;
  readonly logger: Logger;
  readonly now?: () => number;
}

let nextTransfer = 1;

/** A table on its way: the design created on the target and how its columns line up. */
interface Planned {
  readonly name: string;
  readonly source: TableRef;
  readonly target: TableRef;
  readonly design: TableDesign;
  /** Source column names and the target type of each, in the order rows are read. */
  readonly columns: readonly { readonly name: string; readonly neutral: NeutralType }[];
  readonly identity: boolean;
  readonly sequenced: readonly string[];
  readonly notes: TransferNote[];
  /** The table was created by this transfer, rather than found on the target. */
  readonly created: boolean;
}

export class TableTransferService {
  private readonly manager: TableTransferDeps['manager'];
  private readonly logger: Logger;
  private readonly now: () => number;

  constructor(deps: TableTransferDeps) {
    this.manager = deps.manager;
    this.logger = deps.logger.child('transfer');
    this.now = deps.now ?? Date.now;
  }

  async transfer(request: TransferRequest): Promise<TransferReport> {
    const started = this.now();
    const fromDriver = await this.manager.driverOf(request.source.target.connectionId);
    const toDriver = await this.manager.driverOf(request.destination.target.connectionId);
    const run = nextTransfer++;
    const readOwner = ConnectionManager.taskOwner(`transfer-${run}-read`);
    const writeOwner = ConnectionManager.taskOwner(`transfer-${run}-write`);
    const reader = await this.manager.acquire(readOwner, request.source.target);
    let writer: Session | undefined;
    const cancel = (): void => {
      for (const session of [reader, writer]) {
        session?.cancel().catch((error: unknown) => {
          this.logger.warn('Cancelling a transfer statement failed', error);
        });
      }
    };
    request.signal?.addEventListener('abort', cancel);
    const results: TableTransfer[] = [];
    let rows = 0;
    try {
      writer = await this.manager.acquire(writeOwner, request.destination.target);
      await each(reader, fromDriver.dialect.dump.prepare);
      await each(reader, fromDriver.dialect.dump.beginSnapshot);
      await each(writer, toDriver.dialect.dump.header);
      const job = new Job(fromDriver, toDriver, reader, writer, request);
      const existing = new Set(
        (await writer.metadata.listTables(request.destination.scope))
          .filter((table) => table.kind === 'table')
          .map((table) => table.name.toLowerCase()),
      );
      const planned: Planned[] = [];
      for (const name of request.tables) {
        if (aborted(request.signal)) {
          break;
        }
        const result = await job.prepare(name, existing);
        if ('outcome' in result) {
          results.push(result);
        } else {
          planned.push(result);
        }
      }
      for (const [index, table] of planned.entries()) {
        if (aborted(request.signal)) {
          break;
        }
        const copied = await job.copy(table, (count) => {
          request.onProgress?.({
            table: table.name,
            rows: rows + count,
            tablesDone: index,
            tablesTotal: planned.length,
          });
        });
        rows += copied.rows;
        results.push(copied);
      }
      if (!aborted(request.signal)) {
        await job.addKeys(planned, results);
        await each(writer, toDriver.dialect.dump.footer);
      }
      await each(reader, fromDriver.dialect.dump.endSnapshot).catch((error: unknown) => {
        this.logger.warn('Ending the transfer snapshot failed', error);
      });
    } finally {
      request.signal?.removeEventListener('abort', cancel);
      await this.manager.release(readOwner);
      await this.manager.release(writeOwner);
    }
    const order = new Map(request.tables.map((name, index) => [name, index]));
    results.sort((a, b) => (order.get(a.table) ?? 0) - (order.get(b.table) ?? 0));
    const report: TransferReport = {
      outcome: aborted(request.signal) ? 'cancelled' : 'done',
      tables: results,
      rows,
      durationMs: this.now() - started,
    };
    this.logger.info(
      `Transfer ${report.outcome}: ${results.filter((t) => t.outcome === 'copied').length} tables, ${rows} rows`,
    );
    return report;
  }
}

/** One transfer: both sessions and dialects, and the steps per table. */
class Job {
  private readonly from: Dialect;
  private readonly to: Dialect;

  constructor(
    private readonly fromDriver: Driver,
    private readonly toDriver: Driver,
    private readonly reader: Session,
    private readonly writer: Session,
    private readonly request: TransferRequest,
  ) {
    this.from = fromDriver.dialect;
    this.to = toDriver.dialect;
  }

  /** Reads the table, creates (or reuses) it on the target; a failure ends its part early. */
  async prepare(name: string, existing: ReadonlySet<string>): Promise<Planned | TableTransfer> {
    const { request } = this;
    const source: TableRef = { ...request.source.scope, name };
    const target: TableRef = { ...request.destination.scope, name };
    const exists = existing.has(name.toLowerCase());
    const failed = (error: unknown, created = false): TableTransfer => ({
      table: name,
      outcome: 'failed',
      created,
      rows: 0,
      notes: [],
      error: errorMessage(error),
    });
    try {
      if (exists && request.existing === 'skip') {
        return { table: name, outcome: 'skipped', created: false, rows: 0, notes: [] };
      }
      const structure = await this.reader.metadata.describeTable(source);
      const notes: TransferNote[] = [];
      const design = this.translate(name, structure, notes);
      const keysLater = this.to.dump.keysAfterData;
      let created = false;
      if (request.content !== 'data' && (!exists || request.existing === 'replace')) {
        if (exists) {
          await each(this.writer, this.to.dump.dropRelations([target], 'table'));
        }
        const inline = keysLater ? { ...design, foreignKeys: [] } : design;
        await each(this.writer, this.to.ddl.createTable(target, inline));
        created = true;
      } else if (!exists) {
        return failed(new DbError('not-found', msg('{0} does not exist on the target', name)));
      }
      // Rows go into the columns both sides have; an existing table may differ.
      const targetColumns = created
        ? design.columns.map((column) => column.name)
        : (await this.writer.metadata.describeTable(target)).columns
            .filter((column) => !column.generated)
            .map((column) => column.name);
      const wanted = new Set(targetColumns.map((column) => column.toLowerCase()));
      const readable = structure.columns.filter((column) => !column.generated);
      const shared = readable.filter((column) => wanted.has(column.name.toLowerCase()));
      const left = readable.filter((column) => !wanted.has(column.name.toLowerCase()));
      if (left.length > 0) {
        notes.push({ kind: 'columns-skipped', columns: left.map((column) => column.name) });
      }
      const designOf = new Map(design.columns.map((column) => [column.name, column]));
      return {
        name,
        source,
        target,
        design,
        columns: shared.map((column) => ({
          name: column.name,
          neutral: neutralType(
            composedOf(designOf.get(column.name)) ?? column.dataType,
            this.toDriver.id,
          ),
        })),
        identity: shared.some((column) => designOf.get(column.name)?.autoIncrement === true),
        sequenced: shared
          .filter((column) => designOf.get(column.name)?.autoIncrement === true)
          .map((column) => column.name),
        notes,
        created,
      };
    } catch (error) {
      return failed(error);
    }
  }

  /** The table's design for the target: types, defaults and keys in its words. */
  private translate(name: string, structure: TableStructure, notes: TransferNote[]): TableDesign {
    const from = this.fromDriver.id;
    const to = this.toDriver.id;
    const loaded = designFromStructure({ ...this.request.source.scope, name }, structure).design;
    for (const column of structure.columns.filter((c) => c.generated)) {
      notes.push({ kind: 'generated-skipped', column: column.name });
    }
    const indexed = new Set<string>([
      ...structure.primaryKey,
      ...structure.indexes.flatMap((index) => index.columns),
      ...structure.foreignKeys.flatMap((key) => key.columns),
    ]);
    const detailOf = new Map(structure.columns.map((column) => [column.name, column]));
    let columns: ColumnDesign[] = loaded.columns.map((column) =>
      this.translateColumn(column, detailOf.get(column.name), indexed.has(column.name), notes),
    );
    // Index names belong to the schema in PostgreSQL and SQLite, to the table in MySQL;
    // constraint names to the schema in SQL Server and to the database in MySQL. A name
    // that does not say its table (SQLite calls every key fk_1) gets the table in front.
    const own = (original: string): string =>
      from === to || original.toLowerCase().includes(name.toLowerCase())
        ? original
        : `${name}_${original}`.slice(0, 63);
    let design: TableDesign = {
      ...loaded,
      columns,
      indexes: loaded.indexes.map((index) => ({ ...index, name: own(index.name) })),
      // A key goes along when its table does, from the same scope; it then points at
      // the copy in the target scope.
      foreignKeys: loaded.foreignKeys.flatMap((key) => {
        const copied = this.request.tables.some(
          (table) => table.toLowerCase() === key.targetTable.toLowerCase(),
        );
        if (!copied || key.targetSchema !== undefined) {
          notes.push({ kind: 'key-dropped', key: key.name, target: key.targetTable });
          return [];
        }
        return [{ ...key, name: own(key.name) }];
      }),
    };
    // The target may refuse what the source allowed (auto-numbering a non-key column).
    if (designProblems(design, to).some((problem) => problem.kind === 'auto-increment')) {
      columns = columns.map((column) => {
        if (column.autoIncrement) {
          notes.push({ kind: 'auto-increment-dropped', column: column.name });
        }
        return { ...column, autoIncrement: false };
      });
      design = { ...design, columns };
    }
    const problems = designProblems(design, to);
    if (problems.length > 0) {
      throw new DbError(
        'unsupported',
        msg(
          '{0} cannot be created on the target: {1}',
          name,
          problems.map((problem) => problem.kind).join(', '),
        ),
      );
    }
    return design;
  }

  private translateColumn(
    column: ColumnDesign,
    detail: ColumnDetail | undefined,
    indexed: boolean,
    notes: TransferNote[],
  ): ColumnDesign {
    const from = this.fromDriver.id;
    const to = this.toDriver.id;
    const full = detail?.dataType ?? composeType(column.type, column.length);
    // A serial column is a default from a sequence; on the target it numbers itself.
    const serial = /\bnextval\s*\(/iu.test(column.defaultValue);
    const autoIncrement = column.autoIncrement || serial;
    const mapped = mapColumnType(full, from, to, indexed || column.primaryKey);
    const neutral = neutralType(full, from);
    let defaultValue = '';
    if (column.defaultValue !== '' && !serial) {
      const translated = mapDefault(column.defaultValue, neutral, from, to);
      if (translated === undefined) {
        notes.push({
          kind: 'default-dropped',
          column: column.name,
          expression: column.defaultValue,
        });
      } else {
        defaultValue = translated;
      }
    }
    return {
      ...column,
      ...mapped,
      defaultValue: autoIncrement ? '' : defaultValue,
      autoIncrement,
    };
  }

  /** Streams the rows across in batches; a failure ends this table, not the transfer. */
  async copy(table: Planned, progress: (rows: number) => void): Promise<TableTransfer> {
    const { created } = table;
    if (this.request.content === 'structure' || table.columns.length === 0) {
      return { table: table.name, outcome: 'copied', created, rows: 0, notes: table.notes };
    }
    const quotedTable = this.to.quoteTable(table.target);
    const quotedColumns = table.columns.map((column) => this.to.quoteIdentifier(column.name));
    const select = `SELECT ${table.columns.map((column) => this.from.quoteIdentifier(column.name)).join(', ')} FROM ${this.from.quoteTable(table.source)}`;
    const batcher = new RowBatcher();
    let rows = 0;
    const flush = async (tuples: string[]): Promise<void> => {
      if (tuples.length > 0) {
        await each(this.writer, [
          this.to.dump.insert(quotedTable, quotedColumns, tuples, table.identity),
        ]);
      }
    };
    try {
      for await (const event of this.reader.execute(select)) {
        if (event.kind !== 'rows') {
          continue;
        }
        if (aborted(this.request.signal)) {
          throw new DbError('cancelled', msg('The transfer was cancelled'));
        }
        for (const row of event.rows) {
          const literals = table.columns.map((column, index) =>
            exactLiteralOf(this.to, transferValue(row[index] ?? null, column.neutral)),
          );
          const full = batcher.add(`(${literals.join(', ')})`);
          if (full !== undefined) {
            await flush(full);
          }
        }
        rows += event.rows.length;
        progress(rows);
      }
      await flush(batcher.take());
      const reset = this.to.dump.resetSequence;
      if (reset !== undefined) {
        await each(
          this.writer,
          table.sequenced.map((column) => reset(table.target, column)),
        );
      }
      return { table: table.name, outcome: 'copied', created, rows, notes: table.notes };
    } catch (error) {
      if (aborted(this.request.signal)) {
        return {
          table: table.name,
          outcome: 'failed',
          created,
          rows,
          notes: table.notes,
          error: 'cancelled',
        };
      }
      return {
        table: table.name,
        outcome: 'failed',
        created,
        rows,
        notes: table.notes,
        error: errorMessage(error),
      };
    }
  }

  /** Where keys wait for the rows: added now, to the tables that were created. */
  async addKeys(planned: readonly Planned[], results: TableTransfer[]): Promise<void> {
    if (!this.to.dump.keysAfterData) {
      return;
    }
    for (const table of planned) {
      const result = results.find((item) => item.table === table.name);
      if (result?.created !== true || table.design.foreignKeys.length === 0) {
        continue;
      }
      try {
        const plan = this.to.ddl.alterTable(
          table.target,
          { ...table.design, foreignKeys: [] },
          table.design,
          NO_BACKGROUND,
        );
        await each(this.writer, plan.statements);
      } catch (error) {
        const index = results.indexOf(result);
        results[index] = {
          ...result,
          error: msg('Foreign keys were not added: {0}', errorMessage(error)),
        };
      }
    }
  }
}

/** The full type of a designed column, as the target will hold it. */
function composedOf(column: ColumnDesign | undefined): string | undefined {
  return column === undefined ? undefined : composeType(column.type, column.length);
}

function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

async function each(session: Session, statements: readonly string[]): Promise<void> {
  for (const sql of statements) {
    for await (const _event of session.execute(sql)) {
      // Nothing to read back.
    }
  }
}
