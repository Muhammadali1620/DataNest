// Dumps tables, a database or a schema to a SQL script (V5.2). Everything is read
// in one read-only snapshot on a session of its own, rows stream from the server
// straight into the script, and the script is ordered so it loads into an empty
// database: types and sequences, tables, rows, then keys, triggers, views, routines.

import { DbError, errorMessage, isDbError } from '../core/errors';
import type { Logger } from '../core/logging/logger';
import type {
  ListedObjectKind,
  ObjectInfo,
  ObjectRef,
  ObjectScope,
  TableInfo,
  TableRef,
} from '../core/model/objects';
import type { Dialect, Driver, MetadataReader, Session, TableDump } from '../drivers/driver';
import { ConnectionManager, type SessionTarget } from './connection-manager';
import { commentLine, orderViews, RowBatcher, scriptStatement } from './dump-script';
import type { TextSink } from './file-sink';
import { exactLiteralOf } from './sql-literal';

export type DumpContent = 'all' | 'structure' | 'data';

export interface DumpRequest {
  readonly target: SessionTarget;
  /** Where the relations live; also the scope of a whole-scope dump. */
  readonly scope: ObjectScope;
  /** Tables and views to dump. */
  readonly relations: readonly TableInfo[];
  /** Also the scope's routines, sequences, events and types: a whole database or schema. */
  readonly wholeScope: boolean;
  readonly content: DumpContent;
  /** DROP … IF EXISTS before each CREATE. */
  readonly dropFirst: boolean;
  readonly sink: TextSink;
  /** What the script says it was made from, e.g. `Local / shop`. */
  readonly source: string;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: DumpProgress) => void;
}

export interface DumpProgress {
  /** The table whose rows are being written. */
  readonly table?: string;
  /** Rows written so far, over all tables. */
  readonly rows: number;
  /** Tables whose rows are written, and how many there are. */
  readonly tablesDone: number;
  readonly tablesTotal: number;
}

/** An object left out because the server would not show its definition. */
export interface DumpSkip {
  readonly kind: ObjectRef['kind'];
  readonly name: string;
  readonly reason: string;
}

export interface DumpReport {
  /** Objects whose definition the server hid from this user (MySQL routines of others). */
  readonly skipped: readonly DumpSkip[];
  readonly tables: number;
  readonly views: number;
  /** Routines, sequences, events and types. */
  readonly objects: number;
  readonly rows: number;
  readonly durationMs: number;
}

export interface SqlDumperDeps {
  readonly manager: Pick<ConnectionManager, 'acquire' | 'release' | 'driverOf'>;
  readonly logger: Logger;
  readonly now?: () => Date;
}

/** Listed kinds a whole-scope dump writes, besides what comes with the tables. */
const ROUTINES: readonly ListedObjectKind[] = ['function', 'procedure'];

let nextDump = 1;

export class SqlDumper {
  private readonly manager: SqlDumperDeps['manager'];
  private readonly logger: Logger;
  private readonly now: () => Date;

  constructor(deps: SqlDumperDeps) {
    this.manager = deps.manager;
    this.logger = deps.logger.child('dump');
    this.now = deps.now ?? (() => new Date());
  }

  async dump(request: DumpRequest): Promise<DumpReport> {
    const started = this.now().getTime();
    const driver = await this.manager.driverOf(request.target.connectionId);
    const owner = ConnectionManager.taskOwner(`dump-${nextDump++}`);
    const session = await this.manager.acquire(owner, request.target);
    const cancel = (): void => {
      session.cancel().catch((error: unknown) => {
        this.logger.warn('Cancelling the dump query failed', error);
      });
    };
    request.signal?.addEventListener('abort', cancel);
    try {
      const { dump } = driver.dialect;
      await runEach(session, dump.prepare);
      await runEach(session, dump.beginSnapshot);
      try {
        const writer = new DumpWriter(driver, session, request, this.now());
        const counts = await writer.write();
        const report = { ...counts, durationMs: this.now().getTime() - started };
        this.logger.info(
          `Dumped ${report.tables} tables, ${report.views} views, ${report.rows} rows`,
        );
        return report;
      } finally {
        await runEach(session, dump.endSnapshot).catch((error: unknown) => {
          this.logger.warn('Ending the dump snapshot failed', error);
        });
      }
    } catch (error) {
      if (request.signal?.aborted === true) {
        throw new DbError('cancelled', 'The dump was cancelled');
      }
      throw error;
    } finally {
      request.signal?.removeEventListener('abort', cancel);
      await this.manager.release(owner);
    }
  }
}

/** Writes one dump; holds the counts and the order of its sections. */
class DumpWriter {
  private readonly dialect: Dialect;
  private readonly metadata: MetadataReader;
  private readonly tables: TableInfo[];
  private readonly views: TableInfo[];
  private readonly structure: boolean;
  private readonly data: boolean;
  private rows = 0;
  private tablesDone = 0;
  private objects = 0;
  private readonly skipped: DumpSkip[] = [];

  constructor(
    private readonly driver: Driver,
    private readonly session: Session,
    private readonly request: DumpRequest,
    private readonly date: Date,
  ) {
    this.dialect = driver.dialect;
    this.metadata = session.metadata;
    this.tables = request.relations.filter((relation) => relation.kind === 'table');
    this.views = request.relations.filter((relation) => relation.kind === 'view');
    this.structure = request.content !== 'data';
    this.data = request.content !== 'structure';
  }

  async write(): Promise<Omit<DumpReport, 'durationMs'>> {
    const { dump } = this.dialect;
    const { request } = this;
    const tableDumps = new Map<string, TableDump>();
    if (this.structure) {
      for (const table of this.tables) {
        tableDumps.set(table.name, await this.metadata.getTableDump(this.ref(table)));
      }
    }
    const owned = new Set(
      [...tableDumps.values()].flatMap((parts) => parts.owns.map((object) => object.name)),
    );
    const types = this.structure
      ? await this.metadata.listTypeDumps(
          request.scope,
          request.wholeScope ? undefined : this.tables.map((table) => table.name),
        )
      : [];
    const objects = this.structure && request.wholeScope ? await this.listObjects(owned) : [];
    const routines = objects.filter((object) => ROUTINES.includes(object.kind));
    const sequences = objects.filter((object) => object.kind === 'sequence');
    const events = objects.filter((object) => object.kind === 'event');

    await this.head();
    await this.statements(dump.header);

    if (this.structure && request.dropFirst) {
      await this.section('Drop what the script creates');
      const views = this.views.map((view) => this.local(view));
      await this.statements([
        ...dump.dropRelations(
          views.filter((_view, index) => this.views[index]?.materialized !== true),
          'view',
        ),
        ...dump.dropRelations(
          views.filter((_view, index) => this.views[index]?.materialized === true),
          'materialized-view',
        ),
        ...dump.dropRelations(
          this.tables.map((table) => this.local(table)),
          'table',
        ),
        ...[...routines, ...sequences, ...events].map((object) =>
          dump.dropObject(this.localObject(object)),
        ),
        ...types.map((type) => type.drop),
      ]);
    }

    if (this.structure) {
      const { schema } = request.scope;
      if (schema !== undefined && dump.createSchema !== undefined) {
        await this.statements([dump.createSchema(schema)]);
      }
      if (types.length > 0) {
        await this.section('Types');
        await this.statements(types.map((type) => type.create));
        this.objects += types.length;
      }
      if (dump.routinesFirst) {
        await this.writeObjects(routines, 'Functions and procedures');
      }
      await this.writeObjects(sequences, 'Sequences', true);
      for (const table of this.tables) {
        const parts = tableDumps.get(table.name);
        await this.section(`Table ${table.name}`);
        await this.statements([...(parts?.before ?? []), ...(parts?.create ?? [])]);
      }
    }

    if (this.data) {
      for (const table of this.tables) {
        await this.writeRows(table);
        this.tablesDone += 1;
      }
    }

    if (this.structure) {
      const after = this.tables.flatMap((table) => tableDumps.get(table.name)?.after ?? []);
      if (after.length > 0) {
        await this.section('Keys and triggers');
        await this.statements(after);
      }
      await this.writeViews();
      if (!dump.routinesFirst) {
        await this.writeObjects(routines, 'Functions and procedures');
      }
      await this.writeObjects(events, 'Events');
    }

    await this.request.sink.write('\n');
    await this.statements(dump.footer);
    return {
      skipped: this.skipped,
      tables: this.structure || this.data ? this.tables.length : 0,
      views: this.structure ? this.views.length : 0,
      objects: this.objects,
      rows: this.rows,
    };
  }

  private async head(): Promise<void> {
    const { request } = this;
    const what =
      request.content === 'all'
        ? 'structure and data'
        : request.content === 'structure'
          ? 'structure only'
          : 'data only';
    await request.sink.write(
      [
        commentLine('DataNest dump'),
        commentLine(`Source: ${request.source} (${this.driver.id})`),
        commentLine(`Made: ${this.date.toISOString()}`),
        commentLine(`Contents: ${what}`),
        '\n',
      ].join(''),
    );
  }

  /** Routines, sequences and events of the scope; sequences a dumped table owns are left out. */
  private async listObjects(owned: ReadonlySet<string>): Promise<ObjectInfo[]> {
    const kinds = this.driver.capabilities.objectKinds.filter((kind) => kind !== 'trigger');
    const objects: ObjectInfo[] = [];
    for (const kind of kinds) {
      const listed = await this.metadata.listObjects(this.request.scope, kind);
      objects.push(...listed.filter((object) => kind !== 'sequence' || !owned.has(object.name)));
    }
    return objects;
  }

  private async writeObjects(
    objects: readonly ObjectInfo[],
    title: string,
    withoutOwner = false,
  ): Promise<void> {
    if (objects.length === 0) {
      return;
    }
    await this.section(title);
    for (const object of objects) {
      let statements = await this.readable(this.objectRef(object));
      if (statements === undefined) {
        continue;
      }
      if (withoutOwner) {
        // Its owner is not in this dump; the sequence is created on its own.
        statements = statements.filter((sql) => !/^ALTER\s+SEQUENCE\b/iu.test(sql.trim()));
      }
      await this.statements(statements);
      this.objects += 1;
    }
  }

  private async writeViews(): Promise<void> {
    if (this.views.length === 0) {
      return;
    }
    const views: { name: string; sql: string; statements: string[] }[] = [];
    const skipped = this.skipped.length;
    for (const view of this.views) {
      const statements = await this.readable({
        ...this.ref(view),
        kind: 'view',
        ...(view.materialized === true ? { materialized: true } : {}),
      });
      if (statements !== undefined) {
        views.push({ name: view.name, sql: statements.join('\n'), statements });
      }
    }
    if (views.length === 0 && this.skipped.length > skipped) {
      return;
    }
    await this.section('Views');
    for (const view of orderViews(views, this.driver.id)) {
      await this.statements(view.statements);
    }
  }

  private async writeRows(table: TableInfo): Promise<void> {
    const { dump } = this.dialect;
    const ref = this.ref(table);
    const structure = await this.metadata.describeTable(ref);
    const columns = structure.columns.filter((column) => !column.generated);
    if (columns.length === 0) {
      return;
    }
    const quotedTable = this.dialect.quoteTable(this.local(table));
    const quotedColumns = columns.map((column) => this.dialect.quoteIdentifier(column.name));
    const identity = columns.some((column) => column.autoIncrement);
    await this.section(`Rows of ${table.name}`);
    const batcher = new RowBatcher();
    const flush = async (rows: string[]): Promise<void> => {
      if (rows.length > 0) {
        await this.statements([dump.insert(quotedTable, quotedColumns, rows, identity)]);
      }
    };
    const select = `SELECT ${quotedColumns.join(', ')} FROM ${this.dialect.quoteTable(ref)}`;
    for await (const event of this.session.execute(select)) {
      if (event.kind !== 'rows') {
        continue;
      }
      this.checkCancelled();
      for (const row of event.rows) {
        const tuple = `(${columns.map((_column, index) => exactLiteralOf(this.dialect, row[index] ?? null)).join(', ')})`;
        const full = batcher.add(tuple);
        if (full !== undefined) {
          await flush(full);
        }
      }
      this.rows += event.rows.length;
      this.request.onProgress?.({
        table: table.name,
        rows: this.rows,
        tablesDone: this.tablesDone,
        tablesTotal: this.tables.length,
      });
    }
    await flush(batcher.take());
    const resetSequence = dump.resetSequence;
    if (resetSequence !== undefined) {
      const sequenced = columns.filter(
        (column) => column.autoIncrement || /\bnextval\s*\(/iu.test(column.defaultExpression ?? ''),
      );
      await this.statements(
        sequenced.map((column) => resetSequence(this.local(table), column.name)),
      );
    }
  }

  /**
   * The definition, or undefined when the server hides it from this user: the dump
   * goes on without the object, says so in the script and in the report.
   */
  private async readable(object: ObjectRef): Promise<string[] | undefined> {
    try {
      return await this.metadata.getDefinition(object);
    } catch (error) {
      if (!isDbError(error) || error.code !== 'permission-denied') {
        throw error;
      }
      const reason = errorMessage(error);
      this.skipped.push({ kind: object.kind, name: object.name, reason });
      await this.request.sink.write(
        commentLine(`Skipped ${object.kind} ${object.name}: ${reason}`),
      );
      return undefined;
    }
  }

  private checkCancelled(): void {
    if (this.request.signal?.aborted === true) {
      throw new DbError('cancelled', 'The dump was cancelled');
    }
  }

  private async section(title: string): Promise<void> {
    await this.request.sink.write(`\n${commentLine(title)}`);
  }

  private async statements(statements: readonly string[]): Promise<void> {
    const portable = this.dialect.dump.portable ?? ((sql: string) => sql);
    for (const sql of statements) {
      this.checkCancelled();
      await this.request.sink.write(scriptStatement(portable(sql), this.driver.id));
    }
  }

  /** The relation as the session reads it. */
  private ref(relation: TableInfo): TableRef {
    return { ...this.request.scope, name: relation.name };
  }

  /**
   * The relation as the script names it: without the database, so the script loads
   * into whichever database it is run on. The schema stays, schemas are part of it.
   */
  private local(relation: TableInfo): TableRef {
    const { schema } = this.request.scope;
    return schema === undefined ? { name: relation.name } : { schema, name: relation.name };
  }

  private objectRef(object: ObjectInfo): ObjectRef {
    return { ...this.request.scope, ...object };
  }

  private localObject(object: ObjectInfo): ObjectRef {
    const { schema } = this.request.scope;
    return schema === undefined ? { ...object } : { schema, ...object };
  }
}

async function runEach(session: Session, statements: readonly string[]): Promise<void> {
  for (const sql of statements) {
    for await (const _event of session.execute(sql)) {
      // Setup statements return nothing worth reading.
    }
  }
}
