// A MongoDB collection to a file and back (V10.2.7). Export streams the documents as
// canonical Extended JSON, one per line, so every type returns as it was; import reads
// a file a piece at a time — one document per line, as written here or by mongoexport,
// or a JSON array — and inserts in batches, telling which line a refused document was on.

import { errorMessage } from '../../core/errors';
import { EjsonError, fromEjsonDocument, toEjson } from '../../core/mongo/ejson';
import {
  type JsonValue,
  JsonSyntaxError,
  formatJsonLine,
  parseJson,
} from '../../core/json/json-tree';
import { msg } from '../../core/user-message';
import { bool, doc, type MongoDocument, type MongoValue, str } from '../../core/mongo/value';
import type { MongoSession } from '../../drivers/mongo-driver';
import type { TextSink } from '../file-sink';

/** Documents read from the server at a time. */
const READ_BATCH = 500;
/** Documents sent in one insert. */
export const INSERT_BATCH = 500;
/** A JSON array is read whole: larger files must have one document per line. */
export const MAX_ARRAY_FILE_CHARS = 64 * 1024 * 1024;
/** Problems listed in a report; past that only counted. */
export const MAX_REPORTED_PROBLEMS = 100;

export interface ExportRequest {
  readonly session: Pick<MongoSession, 'openCursor'>;
  readonly database: string;
  readonly collection: string;
  readonly sink: TextSink;
  readonly signal?: AbortSignal;
  readonly onProgress?: (documents: number) => void;
}

export async function exportCollection(
  request: ExportRequest,
): Promise<{ readonly documents: number; readonly cancelled: boolean }> {
  const cursor = await request.session.openCursor(request.database, {
    kind: 'find',
    collection: request.collection,
  });
  let documents = 0;
  try {
    for (;;) {
      if (request.signal?.aborted === true) {
        return { documents, cancelled: true };
      }
      const batch = await cursor.next(READ_BATCH);
      if (batch.documents.length > 0) {
        await request.sink.write(
          `${batch.documents.map((raw) => formatJsonLine(toEjson(raw.document))).join('\n')}\n`,
        );
        documents += batch.documents.length;
        request.onProgress?.(documents);
      }
      if (batch.done) {
        return { documents, cancelled: false };
      }
    }
  } finally {
    await cursor.close();
  }
}

export type ImportMode =
  /** The first refused document stops the import; what came before it stays. */
  | 'stop'
  /** Refused documents are left out and listed; the rest go in. */
  | 'skip';

export interface ImportRequest {
  readonly session: Pick<MongoSession, 'command'>;
  readonly database: string;
  readonly collection: string;
  /** The file's text in pieces, as `readTextChunks` gives it. */
  readonly chunks: AsyncIterable<{ readonly text: string }>;
  readonly mode: ImportMode;
  readonly signal?: AbortSignal;
  readonly onProgress?: (inserted: number) => void;
}

export interface ImportProblem {
  /** 1-based line of the file; for a JSON array, the position of the element. */
  readonly line: number;
  readonly message: string;
}

export interface ImportReport {
  readonly inserted: number;
  readonly refused: number;
  readonly problems: readonly ImportProblem[];
  readonly cancelled: boolean;
  /** Set when the import stopped at a problem in `stop` mode. */
  readonly stopped: boolean;
}

interface Pending {
  readonly line: number;
  readonly document: MongoDocument;
}

function numberOf(value: MongoValue | undefined): number {
  return value?.type === 'int32' || value?.type === 'int64' || value?.type === 'double'
    ? Number(value.value)
    : 0;
}

/** Reads the documents of a file and inserts them in batches. */
export async function importCollection(request: ImportRequest): Promise<ImportReport> {
  const problems: ImportProblem[] = [];
  let refused = 0;
  let inserted = 0;
  // An object, not a `let`: the steps below set it from inside their closures.
  const state = { stopped: false };
  const note = (line: number, message: string): void => {
    refused += 1;
    if (problems.length < MAX_REPORTED_PROBLEMS) {
      problems.push({ line, message });
    }
  };
  let pending: Pending[] = [];

  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    const reply = await request.session.command(
      request.database,
      doc([
        ['insert', str(request.collection)],
        ['documents', { type: 'array', items: batch.map((item) => item.document) }],
        // Unordered in skip mode: one refused document does not hold back the rest.
        ['ordered', bool(request.mode === 'stop')],
      ]),
    );
    inserted += numberOf(reply.fields.find(([name]) => name === 'n')?.[1]);
    request.onProgress?.(inserted);
    const errors = reply.fields.find(([name]) => name === 'writeErrors')?.[1];
    if (errors?.type === 'array') {
      for (const error of errors.items) {
        if (error.type !== 'document') {
          continue;
        }
        const index = numberOf(error.fields.find(([name]) => name === 'index')?.[1]);
        const message = error.fields.find(([name]) => name === 'errmsg')?.[1];
        note(
          batch[index]?.line ?? 0,
          message?.type === 'string' ? message.value : msg('The server refused the document'),
        );
      }
      if (errors.items.length > 0 && request.mode === 'stop') {
        state.stopped = true;
      }
    }
  };

  /** One value of the file: a document to insert, or a problem with its line. */
  const take = async (value: JsonValue | Error, line: number): Promise<void> => {
    if (value instanceof Error) {
      note(line, value.message);
      state.stopped = request.mode === 'stop';
      return;
    }
    try {
      pending.push({ line, document: fromEjsonDocument(value) });
    } catch (error) {
      if (!(error instanceof EjsonError)) {
        throw error;
      }
      note(line, error.message);
      state.stopped = request.mode === 'stop';
      return;
    }
    if (pending.length >= INSERT_BATCH) {
      await flush();
    }
  };

  const finish = (cancelled: boolean): ImportReport => ({
    inserted,
    refused,
    problems,
    cancelled,
    stopped: state.stopped,
  });

  let carry = '';
  let line = 0;
  let array: string | undefined;
  for await (const chunk of request.chunks) {
    if (request.signal?.aborted === true) {
      return finish(true);
    }
    if (array !== undefined) {
      array += chunk.text;
      if (array.length > MAX_ARRAY_FILE_CHARS) {
        note(1, msg('A JSON array this large cannot be read whole: write one document per line'));
        return { ...finish(false), stopped: true };
      }
      continue;
    }
    const text = carry + chunk.text;
    if (line === 0 && text.trimStart().startsWith('[')) {
      array = text;
      continue;
    }
    const lines = text.split('\n');
    carry = lines.pop() ?? '';
    for (const raw of lines) {
      line += 1;
      if (raw.trim() !== '') {
        await take(parsed(raw), line);
      }
      if (state.stopped) {
        await flush();
        return finish(false);
      }
    }
  }
  if (array !== undefined) {
    let items: readonly JsonValue[];
    try {
      const value = parseJson(array);
      items = value.type === 'array' ? value.items : [value];
    } catch (error) {
      note(1, errorMessage(error));
      return { ...finish(false), stopped: true };
    }
    for (const [index, item] of items.entries()) {
      if (request.signal?.aborted === true) {
        await flush();
        return finish(true);
      }
      await take(item, index + 1);
      if (state.stopped) {
        break;
      }
    }
  } else if (carry.trim() !== '') {
    line += 1;
    await take(parsed(carry), line);
  }
  await flush();
  return finish(false);
}

function parsed(raw: string): JsonValue | Error {
  try {
    return parseJson(raw.replace(/\r$/u, ''));
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      return error;
    }
    throw error;
  }
}
