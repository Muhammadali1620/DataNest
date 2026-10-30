// What the documents page of a MongoDB collection (V7.6) shows and does, free of
// `vscode`: it parses the query the user types, reads a page and the count, and runs the
// changes the page asks for, then reads again — other clients change documents too.

import { DbError, errorMessage, toDbError } from '../../core/errors';
import { lineAndColumn, parseDocument, ShellSyntaxError } from '../../core/mongo/shell-parse';
import type { MongoDocument } from '../../core/mongo/value';
import type { MongoRawDocument, MongoSession } from '../../drivers/mongo-driver';
import { documentsText, pageView } from '../../services/mongodb/document-view';
import {
  countDocuments,
  type DocumentCount,
  type DocumentQuery,
  deleteDocuments,
  findById,
  idOf,
  insertDocument,
  readPage,
  replaceDocument,
} from '../../services/mongodb/documents';
import { formatPretty } from '../../core/mongo/shell-format';
import {
  DEFAULT_PAGE_SIZE,
  type DocumentQueryText,
  type MongoDocumentsState,
  type TypedProblem,
} from '../../shared/protocols/mongo-documents';
import { msg } from '../../core/user-message';

export interface MongoDocumentsModelDeps {
  readonly connectionName: string;
  readonly database: string;
  readonly collection: string;
  readonly collectionType: 'collection' | 'view' | 'timeseries';
  readonly readOnly: boolean;
  /** The session of the page. */
  readonly session: () => Promise<MongoSession>;
  /** Milliseconds a read may take (`datanest.queryTimeout` or the connection's); 0: no limit. */
  readonly maxTimeMS: () => number;
  readonly now?: () => number;
}

const EMPTY_QUERY: DocumentQueryText = {
  filter: '',
  sort: '',
  projection: '',
  limit: DEFAULT_PAGE_SIZE,
};

/** A text the user typed that is not valid, as the page shows it. */
function problemOf(error: unknown, box: TypedProblem['box'], text: string): TypedProblem {
  if (error instanceof ShellSyntaxError) {
    const { line, column } = lineAndColumn(text, error.offset);
    return { message: error.message, box, line, column };
  }
  return { message: errorMessage(error), box };
}

/** Parses one box of the query; blank is the empty document. */
function parseBox(text: string, box: 'filter' | 'sort' | 'projection'): MongoDocument {
  try {
    return parseDocument(text);
  } catch (error) {
    throw Object.assign(new DbError('syntax', errorMessage(error)), {
      problem: problemOf(error, box, text),
    });
  }
}

function problemFromError(error: unknown): TypedProblem | undefined {
  const problem = (error as { problem?: TypedProblem } | null)?.problem;
  return problem;
}

/** What the documents page talks to: a collection's model, or a statement's result (V7.7). */
export interface DocumentsPage {
  state(): MongoDocumentsState;
  run(texts: DocumentQueryText): Promise<MongoDocumentsState>;
  page(skip: number): Promise<MongoDocumentsState>;
  refresh(): Promise<MongoDocumentsState>;
  count(): Promise<MongoDocumentsState>;
  edit(row: number): Promise<{ token: string; text: string }>;
  save(token: string, text: string): Promise<{ problem?: TypedProblem }>;
  insert(text: string): Promise<{ problem?: TypedProblem }>;
  delete(rows: readonly number[]): Promise<number>;
  copyText(rows: readonly number[]): string;
  describe(rows: readonly number[]): string[];
  /** Lets go of what the page holds on the server, e.g. a result's cursor. */
  close?(): Promise<void>;
}

export class MongoDocumentsModel implements DocumentsPage {
  private texts: DocumentQueryText = EMPTY_QUERY;
  private parsed: Omit<DocumentQuery, 'skip' | 'maxTimeMS'> = {
    filter: { type: 'document', fields: [] },
    sort: { type: 'document', fields: [] },
    projection: { type: 'document', fields: [] },
    limit: DEFAULT_PAGE_SIZE,
  };
  private skip = 0;
  private documents: MongoRawDocument[] = [];
  private more = false;
  private tookMs = 0;
  private total: DocumentCount | undefined;
  private error: TypedProblem | undefined;
  /** The document each open editor started from, by token. */
  private readonly edits = new Map<string, MongoDocument>();
  private nextToken = 1;

  constructor(private readonly deps: MongoDocumentsModelDeps) {}

  /** Documents may be edited and deleted: a plain collection on a connection that allows it. */
  get editable(): boolean {
    return !this.deps.readOnly && this.deps.collectionType === 'collection';
  }

  get insertable(): boolean {
    return !this.deps.readOnly && this.deps.collectionType !== 'view';
  }

  state(): MongoDocumentsState {
    const { columns, rows } = pageView(this.documents);
    return {
      mode: 'collection',
      connectionName: this.deps.connectionName,
      database: this.deps.database,
      collection: this.deps.collection,
      collectionType: this.deps.collectionType,
      readOnly: this.deps.readOnly,
      editable: this.editable,
      insertable: this.insertable,
      query: this.texts,
      skip: this.skip,
      columns,
      rows,
      more: this.more,
      tookMs: this.tookMs,
      ...(this.total === undefined ? {} : { total: this.total }),
      ...(this.error === undefined ? {} : { error: this.error }),
    };
  }

  /** Reads the first page of what a new query finds; a box that does not parse says where. */
  async run(texts: DocumentQueryText): Promise<MongoDocumentsState> {
    try {
      this.parsed = {
        filter: parseBox(texts.filter, 'filter'),
        sort: parseBox(texts.sort, 'sort'),
        projection: parseBox(texts.projection, 'projection'),
        limit: texts.limit,
      };
    } catch (error) {
      this.error = problemFromError(error) ?? { message: errorMessage(error), box: 'filter' };
      return this.state();
    }
    this.texts = texts;
    this.skip = 0;
    await this.read(true);
    return this.state();
  }

  async page(skip: number): Promise<MongoDocumentsState> {
    this.skip = Math.max(0, skip);
    await this.read(false);
    return this.state();
  }

  async refresh(): Promise<MongoDocumentsState> {
    await this.read(true);
    return this.state();
  }

  /** Counts without the usual time limit, when the user asks for it. */
  async count(): Promise<MongoDocumentsState> {
    const session = await this.deps.session();
    this.total = await countDocuments(
      session,
      this.deps.database,
      this.deps.collection,
      this.parsed.filter,
      this.deps.maxTimeMS(),
    );
    return this.state();
  }

  /** The whole document of a row, read again, for the editor. */
  async edit(row: number): Promise<{ token: string; text: string }> {
    this.mayEdit();
    const shown = this.documents[row];
    const id = shown === undefined ? undefined : idOf(shown.document);
    if (id === undefined) {
      throw new DbError(
        shown === undefined ? 'not-found' : 'unsupported',
        shown === undefined
          ? msg('The row is not on the page any more: refresh it')
          : msg('A document without _id cannot be found again to edit it'),
      );
    }
    const session = await this.deps.session();
    // The page may show it cut by a projection; the editor needs all of it, as stored now.
    const current = await findById(session, this.deps.database, this.deps.collection, id);
    if (current === undefined) {
      throw new DbError('not-found', msg('The document was deleted meanwhile'));
    }
    const token = String(this.nextToken);
    this.nextToken += 1;
    this.edits.set(token, current);
    return { token, text: formatPretty(current) };
  }

  /** Saves an edited document; a text that does not parse comes back as a problem. */
  async save(token: string, text: string): Promise<{ problem?: TypedProblem }> {
    this.mayEdit();
    const original = this.edits.get(token);
    if (original === undefined) {
      throw new DbError('not-found', msg('This edit is no longer open: edit the document again'));
    }
    let next: MongoDocument;
    try {
      next = parseDocument(text, 'error');
    } catch (error) {
      return { problem: problemOf(error, 'document', text) };
    }
    const session = await this.deps.session();
    await replaceDocument(session, this.deps.database, this.deps.collection, original, next);
    this.edits.delete(token);
    await this.read(false);
    return {};
  }

  /** Forgets an editor the user closed without saving. */
  discard(token: string): void {
    this.edits.delete(token);
  }

  async insert(text: string): Promise<{ problem?: TypedProblem }> {
    if (!this.insertable) {
      throw this.refusal();
    }
    let document: MongoDocument;
    try {
      document = parseDocument(text, 'error');
    } catch (error) {
      return { problem: problemOf(error, 'document', text) };
    }
    const session = await this.deps.session();
    await insertDocument(session, this.deps.database, this.deps.collection, document);
    await this.read(true);
    return {};
  }

  /** Deletes the documents of rows by their `_id`; returns how many went. */
  async delete(rows: readonly number[]): Promise<number> {
    this.mayEdit();
    const ids = this.documentsOf(rows).map((document) => {
      const id = idOf(document);
      if (id === undefined) {
        throw new DbError(
          'unsupported',
          msg('A document without _id cannot be found again to delete it'),
        );
      }
      return id;
    });
    const session = await this.deps.session();
    const deleted = await deleteDocuments(session, this.deps.database, this.deps.collection, ids);
    await this.read(true);
    return deleted;
  }

  /** The documents of rows, as the page shows them. */
  documentsOf(rows: readonly number[]): MongoDocument[] {
    return rows.flatMap((row) => {
      const raw = this.documents[row];
      return raw === undefined ? [] : [raw.document];
    });
  }

  copyText(rows: readonly number[]): string {
    return documentsText(this.documentsOf(rows));
  }

  /** The rows a delete would take, with their `_id`, for the question. */
  describe(rows: readonly number[]): string[] {
    return this.documentsOf(rows).map((document) => {
      const id = idOf(document);
      return id === undefined ? '?' : formatPretty(id);
    });
  }

  private mayEdit(): void {
    if (!this.editable) {
      throw this.refusal();
    }
  }

  private refusal(): DbError {
    if (this.deps.readOnly) {
      return new DbError(
        'permission-denied',
        msg('The connection is read-only: nothing may change'),
      );
    }
    return new DbError(
      'unsupported',
      this.deps.collectionType === 'view'
        ? msg('A view shows another collection: change the documents there')
        : msg('Documents of a time series collection are added, not edited here'),
    );
  }

  /** Reads the page (and the count, when the query changed); a failure keeps the old page. */
  private async read(withCount: boolean): Promise<void> {
    const session = await this.deps.session();
    try {
      const page = await readPage(
        session,
        this.deps.database,
        this.deps.collection,
        { ...this.parsed, skip: this.skip, maxTimeMS: this.deps.maxTimeMS() },
        this.deps.now,
      );
      this.documents = page.documents;
      this.more = page.more;
      this.tookMs = page.tookMs;
      this.error = undefined;
    } catch (error) {
      const failure = toDbError(error);
      if (failure.code === 'connection-failed') {
        throw failure;
      }
      this.error = { message: failure.message, box: 'filter' };
      return;
    }
    if (withCount) {
      this.total = await this.quickCount(session);
    }
  }

  /** The count within a short time; unknown (and a button to count) when it takes longer. */
  private async quickCount(session: MongoSession): Promise<DocumentCount | undefined> {
    try {
      return await countDocuments(
        session,
        this.deps.database,
        this.deps.collection,
        this.parsed.filter,
      );
    } catch (error) {
      if (toDbError(error).code === 'connection-failed') {
        throw error;
      }
      return undefined;
    }
  }
}
