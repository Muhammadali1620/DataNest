// An Elasticsearch index to a file and back (V13.11), the way a MongoDB collection goes
// (V10.2.7). Export reads the index with a scroll — the one way to page through all
// documents that Elasticsearch and OpenSearch both answer — and writes one JSON document
// per line. Import reads a file a piece at a time and sends `_bulk` in batches, telling
// which line a refused document was on. Numbers keep every digit: documents travel as
// JSON text, never through `JSON.parse`. Free of `vscode`.

import { DbError, errorMessage } from '../../core/errors';
import {
  formatJsonLine,
  type JsonMember,
  type JsonValue,
  JsonSyntaxError,
  jsonNumberText,
  jsonString,
  member,
  parseJson,
} from '../../core/json/json-tree';
import { msg } from '../../core/user-message';
import type { ElasticSession } from '../../drivers/elastic-driver';
import { elasticFailure } from '../../drivers/elasticsearch/errors';
import type { TextSink } from '../file-sink';
import type { ImportMode, ImportProblem, ImportReport } from '../mongodb/collection-files';
import { callJson } from './catalog';

/** Documents read from the server at a time. */
export const READ_BATCH = 1000;
/** Documents sent in one `_bulk`. */
export const BULK_BATCH = 500;
/** A `_bulk` body is cut at about this many characters, whatever the document count. */
export const BULK_BODY_CHARS = 5 * 1024 * 1024;
/** A JSON array is read whole: larger files must have one document per line. */
export const MAX_ARRAY_FILE_CHARS = 64 * 1024 * 1024;
/** Problems listed in a report; past that only counted. */
export const MAX_REPORTED_PROBLEMS = 100;
/** How long the server keeps a scroll between two reads. */
const SCROLL_KEEP_ALIVE = '2m';

/** The `datanest` member of the first line of a file that carries the index's shape. */
export const HEADER_KIND = 'elasticsearch-index';

export type IndexFileFormat =
  /** A header with the mappings and settings, then `{"_id":…,"_source":{…}}` per line. */
  | 'documents-with-mapping'
  /** `{"_id":…,"_source":{…}}` per line. */
  | 'documents'
  /** Action line and source line, as `_bulk` and `curl --data-binary` take them. */
  | 'bulk';

const object = (members: readonly JsonMember[]): JsonValue => ({ type: 'object', members });
const text = (value: string): JsonValue => ({ type: 'string', value });

/** Index settings the server sets itself and refuses on creation. */
const SERVER_SETTINGS = new Set(['uuid', 'creation_date', 'version', 'provided_name', 'resize']);

/** The first member of a reply keyed by the concrete index (an alias would hide it). */
function firstMember(reply: JsonValue): JsonValue | undefined {
  return reply.type === 'object' ? reply.members[0]?.[1] : undefined;
}

/** The mappings and the settings a new index can be made with, from the server. */
export async function readIndexShape(
  session: Pick<ElasticSession, 'request'>,
  index: string,
): Promise<{ readonly mappings: JsonValue; readonly settings: JsonValue }> {
  const path = `/${encodeURIComponent(index)}`;
  const mapping = await callJson(session, { method: 'GET', path: `${path}/_mapping` });
  const settings = await callJson(session, { method: 'GET', path: `${path}/_settings` });
  const own = member(member(firstMember(settings), 'settings'), 'index');
  const kept =
    own?.type === 'object' ? own.members.filter(([name]) => !SERVER_SETTINGS.has(name)) : [];
  return {
    mappings: member(firstMember(mapping), 'mappings') ?? object([]),
    settings: object([['index', object(kept)]]),
  };
}

export interface ExportRequest {
  readonly session: Pick<ElasticSession, 'request'>;
  readonly index: string;
  readonly format: IndexFileFormat;
  readonly sink: TextSink;
  readonly signal?: { readonly aborted: boolean };
  readonly onProgress?: (documents: number) => void;
}

/** What `_bulk` wants before a source: the id, and the routing when the document has one. */
function actionMembers(id: string | undefined, routing: string | undefined): JsonMember[] {
  return [
    ...(id === undefined ? [] : [['_id', text(id)] as const]),
    ...(routing === undefined ? [] : [['routing', text(routing)] as const]),
  ];
}

/** The lines one hit becomes in the file. */
function linesOf(hit: JsonValue, format: IndexFileFormat): string[] {
  const source = member(hit, '_source');
  if (source === undefined) {
    throw new DbError(
      'unsupported',
      msg('The index does not keep the source of its documents, so they cannot be exported'),
    );
  }
  const id = jsonString(member(hit, '_id'));
  const routing = jsonString(member(hit, '_routing'));
  if (format === 'bulk') {
    return [
      formatJsonLine(object([['index', object(actionMembers(id, routing))]])),
      formatJsonLine(source),
    ];
  }
  return [
    formatJsonLine(
      object([
        ...(id === undefined ? [] : [['_id', text(id)] as const]),
        ...(routing === undefined ? [] : [['_routing', text(routing)] as const]),
        ['_source', source],
      ]),
    ),
  ];
}

export async function exportIndex(
  request: ExportRequest,
): Promise<{ readonly documents: number; readonly cancelled: boolean }> {
  const { session, index } = request;
  if (request.format === 'documents-with-mapping') {
    const shape = await readIndexShape(session, index);
    await request.sink.write(
      `${formatJsonLine(
        object([
          ['datanest', text(HEADER_KIND)],
          ['version', { type: 'number', text: '1' }],
          ['index', text(index)],
          ['settings', shape.settings],
          ['mappings', shape.mappings],
        ]),
      )}\n`,
    );
  }
  let documents = 0;
  let scrollId: string | undefined;
  try {
    let page = await callJson(session, {
      method: 'POST',
      path: `/${encodeURIComponent(index)}/_search?scroll=${SCROLL_KEEP_ALIVE}`,
      body: JSON.stringify({ size: READ_BATCH, sort: ['_doc'] }),
    });
    for (;;) {
      scrollId = jsonString(member(page, '_scroll_id')) ?? scrollId;
      const hits = member(member(page, 'hits'), 'hits');
      const items = hits?.type === 'array' ? hits.items : [];
      if (items.length === 0) {
        return { documents, cancelled: false };
      }
      await request.sink.write(
        `${items.flatMap((hit) => linesOf(hit, request.format)).join('\n')}\n`,
      );
      documents += items.length;
      request.onProgress?.(documents);
      if (request.signal?.aborted === true) {
        return { documents, cancelled: true };
      }
      if (scrollId === undefined) {
        // A reply without a scroll cannot be continued; the first page is all there is.
        return { documents, cancelled: false };
      }
      page = await callJson(session, {
        method: 'POST',
        path: '/_search/scroll',
        body: JSON.stringify({ scroll: SCROLL_KEEP_ALIVE, scroll_id: scrollId }),
      });
    }
  } finally {
    if (scrollId !== undefined) {
      try {
        await session.request({
          method: 'DELETE',
          path: '/_search/scroll',
          body: JSON.stringify({ scroll_id: scrollId }),
        });
      } catch {
        // The scroll expires by itself.
      }
    }
  }
}

/** What the first line of a file says about the index it came from. */
export interface IndexFileHeader {
  readonly index?: string;
  readonly settings?: JsonValue;
  readonly mappings?: JsonValue;
}

function headerOf(value: JsonValue): IndexFileHeader | undefined {
  if (jsonString(member(value, 'datanest')) !== HEADER_KIND) {
    return undefined;
  }
  const index = jsonString(member(value, 'index'));
  const settings = member(value, 'settings');
  const mappings = member(value, 'mappings');
  return {
    ...(index === undefined ? {} : { index }),
    ...(settings === undefined ? {} : { settings }),
    ...(mappings === undefined ? {} : { mappings }),
  };
}

/** The body for creating an index like the one a file came from; `''` for the defaults. */
export function createBodyOf(header: IndexFileHeader | undefined): string {
  const members: JsonMember[] = [
    ...(header?.settings === undefined ? [] : [['settings', header.settings] as const]),
    ...(header?.mappings === undefined ? [] : [['mappings', header.mappings] as const]),
  ];
  return members.length === 0 ? '' : formatJsonLine(object(members));
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

/** One value of a file with the line (or array position, from 1) it was on. */
interface Entry {
  readonly value: JsonValue | Error;
  readonly line: number;
}

/**
 * The values of a file: one per line, or the elements of a JSON array. A line that is
 * not JSON comes as an `Error`, so the caller can report its line and go on.
 */
async function* entriesOf(chunks: AsyncIterable<{ readonly text: string }>): AsyncGenerator<Entry> {
  let carry = '';
  let line = 0;
  let array: string | undefined;
  for await (const chunk of chunks) {
    if (array !== undefined) {
      array += chunk.text;
      if (array.length > MAX_ARRAY_FILE_CHARS) {
        yield {
          value: new Error(
            msg('A JSON array this large cannot be read whole: write one document per line'),
          ),
          line: 1,
        };
        return;
      }
      continue;
    }
    const joined = carry + chunk.text;
    if (line === 0 && joined.trimStart().startsWith('[')) {
      array = joined;
      continue;
    }
    const lines = joined.split('\n');
    carry = lines.pop() ?? '';
    for (const raw of lines) {
      line += 1;
      if (raw.trim() !== '') {
        yield { value: parsed(raw), line };
      }
    }
  }
  if (array !== undefined) {
    let items: readonly JsonValue[];
    try {
      const value = parseJson(array);
      items = value.type === 'array' ? value.items : [value];
    } catch (error) {
      yield { value: new Error(errorMessage(error)), line: 1 };
      return;
    }
    for (const [index, item] of items.entries()) {
      yield { value: item, line: index + 1 };
    }
  } else if (carry.trim() !== '') {
    yield { value: parsed(carry), line: line + 1 };
  }
}

/** The header of a file, or undefined when it has none (or is not a file of ours). */
export async function readFileHeader(
  chunks: AsyncIterable<{ readonly text: string }>,
): Promise<IndexFileHeader | undefined> {
  const entries = entriesOf(chunks);
  try {
    const first = await entries.next();
    return first.done === true || first.value.value instanceof Error
      ? undefined
      : headerOf(first.value.value);
  } finally {
    // Stops the file read; the rest of the file is not needed.
    await entries.return(undefined);
  }
}

export type IdMode =
  /** The id of each document in the file is the id it gets. */
  | 'keep'
  /** Elasticsearch makes up an id for each document. */
  | 'generate';

export type WriteOp =
  /** A document with the id of an existing one replaces it. */
  | 'index'
  /** A document with the id of an existing one is refused (409). */
  | 'create';

export interface ImportRequest {
  readonly session: Pick<ElasticSession, 'request'>;
  readonly index: string;
  /** The file's text in pieces, as `readTextChunks` gives it. */
  readonly chunks: AsyncIterable<{ readonly text: string }>;
  readonly mode: ImportMode;
  readonly ids: IdMode;
  readonly op: WriteOp;
  readonly signal?: { readonly aborted: boolean };
  readonly onProgress?: (inserted: number) => void;
}

interface Pending {
  readonly line: number;
  /** The two lines `_bulk` takes for this document, with the newline after each. */
  readonly body: string;
}

/** A number or a string `_id`, as text. */
function idOf(value: JsonValue | undefined): string | undefined {
  return jsonString(value) ?? jsonNumberText(value);
}

const BULK_ACTIONS = new Set(['index', 'create', 'update', 'delete']);

/** Why `_bulk` refused one item, in one line. */
function reasonOf(item: JsonValue | undefined): string {
  const error = member(item, 'error');
  const reason = jsonString(member(error, 'reason')) ?? jsonString(error);
  const type = jsonString(member(error, 'type'));
  if (reason === undefined) {
    return msg('The server refused the document');
  }
  return type === undefined ? reason : `${type}: ${reason}`;
}

/** Reads the documents of a file and sends them in `_bulk` batches. */
export async function importIndex(request: ImportRequest): Promise<ImportReport> {
  const problems: ImportProblem[] = [];
  let refused = 0;
  let inserted = 0;
  // An object, not a `let`: the steps below set it from inside their closures.
  const state: {
    stopped: boolean;
    // The action line of a `_bulk` pair, waiting for the source line after it.
    awaiting:
      { readonly line: number; readonly id?: string; readonly routing?: string } | undefined;
  } = { stopped: false, awaiting: undefined };
  const note = (line: number, message: string): void => {
    refused += 1;
    if (problems.length < MAX_REPORTED_PROBLEMS) {
      problems.push({ line, message });
    }
    if (request.mode === 'stop') {
      state.stopped = true;
    }
  };
  let pending: Pending[] = [];
  let pendingChars = 0;

  const flush = async (): Promise<void> => {
    if (pending.length === 0) {
      return;
    }
    const batch = pending;
    pending = [];
    pendingChars = 0;
    const response = await request.session.request({
      method: 'POST',
      path: `/${encodeURIComponent(request.index)}/_bulk`,
      body: batch.map((item) => item.body).join(''),
      ndjson: true,
    });
    if (response.status >= 400) {
      throw elasticFailure(response);
    }
    const items = member(parseReply(response.body), 'items');
    const results = items?.type === 'array' ? items.items : [];
    for (const [position, entry] of batch.entries()) {
      const item = results[position];
      const outcome = item?.type === 'object' ? item.members[0]?.[1] : undefined;
      const status = Number(jsonNumberText(member(outcome, 'status')) ?? '200');
      if (status >= 300) {
        note(entry.line, reasonOf(outcome));
      } else {
        inserted += 1;
      }
    }
    request.onProgress?.(inserted);
  };

  const add = async (
    line: number,
    source: JsonValue,
    id: string | undefined,
    routing: string | undefined,
  ): Promise<void> => {
    const action = formatJsonLine(
      object([
        [request.op, object(actionMembers(request.ids === 'keep' ? id : undefined, routing))],
      ]),
    );
    const body = `${action}\n${formatJsonLine(source)}\n`;
    pending.push({ line, body });
    pendingChars += body.length;
    if (pending.length >= BULK_BATCH || pendingChars >= BULK_BODY_CHARS) {
      await flush();
    }
  };

  /** One value of the file: a document to send, or a problem with its line. */
  const take = async (value: JsonValue | Error, line: number): Promise<void> => {
    if (value instanceof Error) {
      note(line, value.message);
      return;
    }
    if (value.type !== 'object') {
      note(line, msg('A document must be a JSON object'));
      state.awaiting = undefined;
      return;
    }
    if (state.awaiting !== undefined) {
      const { id, routing, line: at } = state.awaiting;
      state.awaiting = undefined;
      await add(at, value, id, routing);
      return;
    }
    if (headerOf(value) !== undefined) {
      return;
    }
    const only = value.members.length === 1 ? value.members[0] : undefined;
    if (only !== undefined && BULK_ACTIONS.has(only[0]) && only[1].type === 'object') {
      if (only[0] === 'update' || only[0] === 'delete') {
        note(line, msg('Only index and create actions can be loaded, not "{0}"', only[0]));
        return;
      }
      const id = idOf(member(only[1], '_id'));
      const routing =
        jsonString(member(only[1], 'routing')) ?? jsonString(member(only[1], '_routing'));
      state.awaiting = {
        line,
        ...(id === undefined ? {} : { id }),
        ...(routing === undefined ? {} : { routing }),
      };
      return;
    }
    const source = member(value, '_source');
    if (source?.type === 'object') {
      await add(line, source, idOf(member(value, '_id')), jsonString(member(value, '_routing')));
      return;
    }
    await add(line, value, undefined, undefined);
  };

  const finish = (cancelled: boolean): ImportReport => ({
    inserted,
    refused,
    problems,
    cancelled,
    stopped: state.stopped,
  });

  /** Makes what was sent searchable; a failure here does not undo the import. */
  const refresh = async (): Promise<void> => {
    try {
      await request.session.request({
        method: 'POST',
        path: `/${encodeURIComponent(request.index)}/_refresh`,
      });
    } catch {
      // The index refreshes by itself within a second.
    }
  };

  let cancelled = false;
  for await (const entry of entriesOf(request.chunks)) {
    if (request.signal?.aborted === true) {
      cancelled = true;
      break;
    }
    await take(entry.value, entry.line);
    if (state.stopped) {
      break;
    }
  }
  if (state.awaiting !== undefined && !state.stopped && !cancelled) {
    note(state.awaiting.line, msg('The action line has no document after it'));
  }
  await flush();
  await refresh();
  return finish(cancelled);
}

function parseReply(body: string): JsonValue {
  try {
    return parseJson(body);
  } catch {
    return object([]);
  }
}
