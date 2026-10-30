// The result of a statement run in a MongoDB query editor (V7.7), shown on the documents
// page: a cursor read forward as the user pages on, kept so that paging back costs
// nothing, or the few documents a command returned. Results are only read here; the
// editor is where statements change data. Free of `vscode`.

import { DbError } from '../../core/errors';
import { doc, type MongoDocument } from '../../core/mongo/value';
import type { MongoCursor, MongoRawDocument } from '../../drivers/mongo-driver';
import { documentsText, pageView } from '../../services/mongodb/document-view';
import { idOf } from '../../services/mongodb/documents';
import { formatPretty } from '../../core/mongo/shell-format';
import type { RunOutcome } from '../../services/mongodb/shell-run';
import {
  DEFAULT_PAGE_SIZE,
  type MongoDocumentsState,
  type TypedProblem,
} from '../../shared/protocols/mongo-documents';
import type { DocumentsPage } from './mongo-documents-model';
import { msg } from '../../core/user-message';

/** Documents a result keeps in memory; the cursor is closed after them. */
export const MAX_RESULT_DOCUMENTS = 10_000;

export interface MongoResultTexts {
  /** "250 documents", for a count. */
  count(count: string): string;
  /** What a write did, in words. */
  write(outcome: Extract<RunOutcome, { kind: 'write' }>): string;
  /** "The first 10 000 documents are shown". */
  capped(count: number): string;
}

export interface MongoResultModelDeps {
  readonly connectionName: string;
  readonly database: string;
  readonly statement: string;
  readonly outcome: Exclude<RunOutcome, { kind: 'use' }>;
  readonly tookMs: number;
  readonly texts: MongoResultTexts;
  readonly pageSize?: number;
}

function raw(document: MongoRawDocument['document']): MongoRawDocument {
  return { document, size: formatPretty(document).length };
}

export class MongoResultModel implements DocumentsPage {
  private readonly buffer: MongoRawDocument[] = [];
  private cursor: MongoCursor | undefined;
  private skip = 0;
  private readonly pageSize: number;
  private summary: string | undefined;
  private capped = false;

  private constructor(private readonly deps: MongoResultModelDeps) {
    this.pageSize = deps.pageSize ?? DEFAULT_PAGE_SIZE;
    const { outcome } = deps;
    switch (outcome.kind) {
      case 'cursor':
        this.cursor = outcome.cursor;
        break;
      case 'documents':
        this.buffer.push(...outcome.documents.map(raw));
        break;
      case 'count':
        this.buffer.push(raw(doc([['count', { type: 'int64', value: outcome.count }]])));
        this.summary = deps.texts.count(outcome.count);
        break;
      case 'write':
        this.buffer.push(raw(outcome.reply));
        this.summary = deps.texts.write(outcome);
        break;
    }
  }

  /** A result with its first page read. */
  static async open(deps: MongoResultModelDeps): Promise<MongoResultModel> {
    const model = new MongoResultModel(deps);
    await model.fill(model.pageSize + 1);
    return model;
  }

  get collection(): string {
    return this.deps.outcome.kind === 'cursor' ? (this.deps.outcome.collection ?? '') : '';
  }

  state(): MongoDocumentsState {
    const shown = this.buffer.slice(this.skip, this.skip + this.pageSize);
    const { columns, rows } = pageView(shown);
    const exhausted = this.cursor === undefined;
    const summary = this.capped ? this.deps.texts.capped(MAX_RESULT_DOCUMENTS) : this.summary;
    return {
      mode: 'result',
      statement: this.deps.statement,
      ...(summary === undefined ? {} : { summary }),
      connectionName: this.deps.connectionName,
      database: this.deps.database,
      collection: this.collection,
      collectionType: 'collection',
      readOnly: true,
      editable: false,
      insertable: false,
      query: { filter: '', sort: '', projection: '', limit: this.pageSize },
      skip: this.skip,
      columns,
      rows,
      more: this.buffer.length > this.skip + this.pageSize || !exhausted,
      tookMs: this.deps.tookMs,
      // A count is known once the cursor has nothing more to give, unless it was cut.
      ...(exhausted && !this.capped
        ? { total: { count: String(this.buffer.length), exact: true } }
        : {}),
    };
  }

  run(): Promise<MongoDocumentsState> {
    return Promise.reject(this.readOnlyResult());
  }

  /** Reads forward from the cursor as far as the page needs; going back reads nothing. */
  async page(skip: number): Promise<MongoDocumentsState> {
    const start = Math.max(0, Math.min(skip, MAX_RESULT_DOCUMENTS));
    await this.fill(start + this.pageSize + 1);
    // Past the end, the last page is shown.
    this.skip =
      start < this.buffer.length || this.buffer.length === 0
        ? start
        : Math.floor((this.buffer.length - 1) / this.pageSize) * this.pageSize;
    return this.state();
  }

  refresh(): Promise<MongoDocumentsState> {
    return Promise.resolve(this.state());
  }

  /** Reads the rest of the cursor, to know how many documents there are. */
  async count(): Promise<MongoDocumentsState> {
    await this.fill(MAX_RESULT_DOCUMENTS + 1);
    return this.state();
  }

  edit(): Promise<{ token: string; text: string }> {
    return Promise.reject(this.readOnlyResult());
  }

  save(): Promise<{ problem?: TypedProblem }> {
    return Promise.reject(this.readOnlyResult());
  }

  insert(): Promise<{ problem?: TypedProblem }> {
    return Promise.reject(this.readOnlyResult());
  }

  delete(): Promise<number> {
    return Promise.reject(this.readOnlyResult());
  }

  copyText(rows: readonly number[]): string {
    return documentsText(this.documentsOf(rows));
  }

  describe(rows: readonly number[]): string[] {
    return this.documentsOf(rows).map((document) => {
      const id = idOf(document);
      return id === undefined ? '?' : formatPretty(id);
    });
  }

  /** Lets go of the server's cursor, e.g. when a new result replaces this one. */
  async close(): Promise<void> {
    const cursor = this.cursor;
    this.cursor = undefined;
    await cursor?.close().catch(() => undefined);
  }

  private documentsOf(rows: readonly number[]): MongoDocument[] {
    return rows.flatMap((row) => {
      const found = this.buffer[this.skip + row];
      return found === undefined ? [] : [found.document];
    });
  }

  private readOnlyResult(): DbError {
    return new DbError(
      'unsupported',
      msg(
        'A result is only read here: change documents with a statement, or on the collection’s page',
      ),
    );
  }

  /** Reads from the cursor until the buffer holds `wanted` documents or the cursor ends. */
  private async fill(wanted: number): Promise<void> {
    while (
      this.cursor !== undefined &&
      this.buffer.length < Math.min(wanted, MAX_RESULT_DOCUMENTS)
    ) {
      const { documents, done } = await this.cursor.next(
        Math.min(wanted, MAX_RESULT_DOCUMENTS) - this.buffer.length,
      );
      this.buffer.push(...documents);
      if (done) {
        this.cursor = undefined;
      }
    }
    if (
      this.cursor !== undefined &&
      this.buffer.length >= MAX_RESULT_DOCUMENTS &&
      wanted > MAX_RESULT_DOCUMENTS
    ) {
      this.capped = true;
      await this.close();
    }
  }
}
