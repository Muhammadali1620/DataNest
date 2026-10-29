// Requests of an Elasticsearch query document (V7.8), written the way consoles write them:
//
//   GET /products/_search
//   { "query": { "match": { "name": "lamp" } } }
//
// A request starts at a line with an HTTP method and a path and takes the lines below it
// as its body, up to the next such line. `_bulk` and `_msearch` take one JSON per line.
// `#` and `//` lines are comments. What a request may change is decided from it alone.

import {
  formatJsonLine,
  type JsonValue,
  JsonSyntaxError,
  member,
  parseJson,
  parseJsonLines,
} from '../json/json-tree';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'HEAD', 'PATCH'] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

const REQUEST_LINE = /^[ \t]*(GET|POST|PUT|DELETE|HEAD|PATCH)[ \t]+(\S+)[ \t]*$/i;

export interface ElasticRequestText {
  readonly method: HttpMethod;
  /** The path as written, with its query. */
  readonly path: string;
  /** The body lines, comments left out; empty without a body. */
  readonly body: string;
  /** Offsets of the request in the document: its method line to its last body line. */
  readonly start: number;
  readonly end: number;
  /** Where the body starts in the document. */
  readonly bodyStart: number;
}

function isComment(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('#') || trimmed.startsWith('//');
}

export function splitRequests(text: string): ElasticRequestText[] {
  const requests: ElasticRequestText[] = [];
  let current:
    | {
        method: HttpMethod;
        path: string;
        start: number;
        bodyStart: number;
        lines: string[];
        end: number;
      }
    | undefined;
  const finish = (): void => {
    if (current !== undefined) {
      requests.push({
        method: current.method,
        path: current.path,
        body: current.lines.join('\n').trim(),
        start: current.start,
        end: current.end,
        bodyStart: current.bodyStart,
      });
    }
    current = undefined;
  };
  let offset = 0;
  for (const line of text.split('\n')) {
    const lineEnd = offset + line.length;
    const match = REQUEST_LINE.exec(line.replace(/\r$/, ''));
    if (match !== null) {
      finish();
      const start = offset + (line.length - line.trimStart().length);
      current = {
        method: (match[1]?.toUpperCase() ?? 'GET') as HttpMethod,
        path: match[2] ?? '/',
        start,
        bodyStart: lineEnd + 1,
        lines: [],
        end: offset + line.trimEnd().length,
      };
    } else if (current !== undefined && !isComment(line)) {
      current.lines.push(line);
      if (line.trim() !== '') {
        current.end = offset + line.trimEnd().length;
      }
    }
    offset = lineEnd + 1;
  }
  finish();
  return requests;
}

/** The request at an offset (a cursor), or the one before it. */
export function requestAt(text: string, offset: number): ElasticRequestText | undefined {
  const requests = splitRequests(text);
  return [...requests].reverse().find((request) => request.start <= offset) ?? requests[0];
}

/** The path without its query, its segments without empty ones. */
export function pathSegments(path: string): string[] {
  return (path.split('?')[0] ?? '').split('/').filter((segment) => segment !== '');
}

/** Endpoints whose body is one JSON value per line. */
function isNdjson(path: string): boolean {
  const segments = pathSegments(path);
  const last = segments.at(-1) ?? '';
  return (
    last === '_bulk' ||
    last === '_msearch' ||
    (last === 'template' && segments.at(-2) === '_msearch')
  );
}

export interface ParsedRequest {
  readonly method: HttpMethod;
  /** Starts with `/`. */
  readonly path: string;
  /** The body as the server gets it: one line of JSON, or NDJSON lines. */
  readonly body?: string;
  readonly ndjson: boolean;
  /** The parsed JSON of a JSON body, for deciding what the request does. */
  readonly json?: JsonValue;
}

/** A body that is not JSON, and where in the document. */
export class RequestSyntaxError extends Error {
  override readonly name = 'RequestSyntaxError';

  constructor(
    message: string,
    readonly offset: number,
  ) {
    super(message);
  }
}

export function parseRequest(request: ElasticRequestText, document: string): ParsedRequest {
  const path = request.path.startsWith('/') ? request.path : `/${request.path}`;
  const ndjson = isNdjson(path);
  if (request.body === '') {
    return { method: request.method, path, ndjson };
  }
  // The body as written in the document, comments left out, with its offset there.
  const raw = document.slice(request.bodyStart, request.end);
  const lines = raw
    .split('\n')
    .map((line) => (isComment(line) ? ' '.repeat(line.length) : line))
    .join('\n');
  try {
    if (ndjson) {
      const values = parseJsonLines(lines);
      return {
        method: request.method,
        path,
        ndjson,
        body: `${values.map((entry) => formatJsonLine(entry.value)).join('\n')}\n`,
      };
    }
    const json = parseJson(lines);
    return { method: request.method, path, ndjson, body: formatJsonLine(json), json };
  } catch (error) {
    if (error instanceof JsonSyntaxError) {
      throw new RequestSyntaxError(error.message, request.bodyStart + error.offset);
    }
    throw error;
  }
}

export type RequestEffect = 'read' | 'write' | 'dangerous';

/** Endpoints that only read, whatever the method (`POST /_search`). */
const READ_ENDPOINTS = new Set([
  '_search',
  '_msearch',
  '_count',
  '_mget',
  '_explain',
  '_field_caps',
  '_validate',
  '_sql',
  '_eql',
  '_query',
  '_async_search',
  '_pit',
  '_terms_enum',
  '_termvectors',
  '_mtermvectors',
  '_render',
  '_rank_eval',
  '_analyze',
  '_search_shards',
  '_knn_search',
]);

/** True when a body asks for every document: no query, or `match_all`. */
function matchesAll(json: JsonValue | undefined): boolean {
  const query = member(json, 'query');
  return query === undefined || member(query, 'match_all') !== undefined;
}

/** What a request may change, before it is sent. */
export function requestEffect(request: ParsedRequest): RequestEffect {
  if (request.method === 'GET' || request.method === 'HEAD') {
    return 'read';
  }
  const segments = pathSegments(request.path);
  // `_search` anywhere reads: `/_search/template`, `/index/_search`, `/_search/scroll`.
  if (segments.some((segment) => READ_ENDPOINTS.has(segment))) {
    return 'read';
  }
  const endpoint = segments.find((segment) => segment.startsWith('_'));
  if (endpoint === '_delete_by_query' || endpoint === '_update_by_query') {
    return matchesAll(request.json) ? 'dangerous' : 'write';
  }
  // DELETE of an index (or of every index), not of a document or a setting.
  if (request.method === 'DELETE' && endpoint === undefined) {
    return 'dangerous';
  }
  if (request.method === 'DELETE' && (segments[0] === '_all' || segments[0] === '*')) {
    return 'dangerous';
  }
  return 'write';
}
