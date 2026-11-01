// The Query API of Neo4j 5.19+ (`POST /db/<name>/query/v2`), spoken over `node:http(s)`:
// JSON in, JSON out, one request per statement and every request its own transaction.
// Asking for `application/vnd.neo4j.query` makes the server tag each value with its type,
// so 64-bit integers, dates and nodes arrive without guessing. Written from the public
// API description.

import type { Agent as HttpAgent } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import { agentFor } from '../libsql/hrana';
import { fromHttpStatus, fromNeo4jError, type Neo4jError } from './errors';

export { agentFor };

/** The largest answer read into memory; a bigger result asks for narrower Cypher instead. */
export const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

/** A value as the server tags it: `{ "$type": "Integer", "_value": "42" }`. */
export interface TypedValue {
  readonly $type?: unknown;
  readonly _value?: unknown;
}

export interface QueryAnswer {
  readonly fields: readonly string[];
  readonly values: readonly (readonly TypedValue[])[];
  /** Notices of the server about the statement (cartesian products, deprecations, …). */
  readonly notifications: readonly string[];
  readonly counters: Readonly<Record<string, unknown>> | undefined;
}

/** The address of a server from what the form holds; `neo4j://`, `neo4j+s://` and URLs work. */
export function targetUrl(host: string | undefined, port: number | undefined, tls: boolean): URL {
  const text = (host ?? '').trim() === '' ? 'localhost' : (host ?? '').trim();
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) {
    const plain = text.replace(/^neo4j(\+s(?:sc)?)?:/iu, (_all, secure: string | undefined) =>
      secure === undefined ? 'http:' : 'https:',
    );
    const parsed = new URL(plain);
    const url = new URL(`${parsed.protocol === 'https:' ? 'https' : 'http'}://${parsed.host}`);
    if (parsed.port === '' && port !== undefined) {
      url.port = String(port);
    }
    return url;
  }
  const name = text.includes(':') && !text.startsWith('[') ? `[${text}]` : text;
  const chosen = port ?? (tls ? 443 : 7474);
  return new URL(`${tls ? 'https' : 'http'}://${name}:${chosen}`);
}

/** `Basic base64(user:password)`; undefined when neither is given. */
export function basicAuthorization(
  user: string | undefined,
  password: string | undefined,
): string | undefined {
  const name = user ?? '';
  const secret = password ?? '';
  if (name === '' && secret === '') {
    return undefined;
  }
  return `Basic ${Buffer.from(`${name}:${secret}`, 'utf8').toString('base64')}`;
}

/** The endpoint of one database. */
export function queryUrl(base: URL, database: string): URL {
  const url = new URL(base.href);
  url.pathname = `${base.pathname.replace(/\/+$/u, '')}/db/${encodeURIComponent(database)}/query/v2`;
  return url;
}

interface HttpAnswer {
  readonly status: number;
  readonly body: string;
}

/** POSTs JSON; the signal aborts the request, and the server gives up the statement with it. */
export function postQuery(
  url: URL,
  body: string,
  options: {
    readonly authorization: string | undefined;
    readonly agent: HttpAgent | HttpsAgent;
    readonly signal: AbortSignal | undefined;
  },
): Promise<HttpAnswer> {
  return new Promise<HttpAnswer>((resolve, reject) => {
    const send = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = send(
      url,
      {
        method: 'POST',
        agent: options.agent,
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          accept: 'application/vnd.neo4j.query',
          ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > MAX_RESPONSE_BYTES) {
            request.destroy(
              new DbError(
                'unsupported',
                msg('The result is larger than 256 MB: narrow the query with a LIMIT'),
              ),
            );
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString('utf8'),
          });
        });
        response.on('error', reject);
      },
    );
    const onAbort = (): void => {
      // A signal made by AbortSignal.timeout says so in its reason; anything else is a cancel.
      const timedOut =
        (options.signal?.reason as { name?: unknown } | undefined)?.name === 'TimeoutError';
      request.destroy(
        timedOut
          ? new DbError('timeout', msg('The server did not answer in time'))
          : new DbError('cancelled', msg('The statement was cancelled')),
      );
    };
    if (options.signal?.aborted === true) {
      onAbort();
    }
    options.signal?.addEventListener('abort', onAbort, { once: true });
    request.on('error', reject);
    request.on('close', () => {
      options.signal?.removeEventListener('abort', onAbort);
    });
    request.end(body);
  });
}

/** Parses an answer into fields and rows, or throws the error the server reported. */
export function readAnswer(answer: HttpAnswer): QueryAnswer {
  if (answer.status >= 400) {
    throw fromHttpStatus(answer.status, answer.body);
  }
  let parsed: {
    data?: { fields?: unknown; values?: unknown };
    errors?: unknown;
    counters?: unknown;
    notifications?: unknown;
  };
  try {
    parsed = JSON.parse(answer.body) as typeof parsed;
  } catch {
    throw new DbError(
      'internal',
      msg('The server answered with something that is not JSON (is this the HTTP port of Neo4j?)'),
    );
  }
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    throw fromNeo4jError(parsed.errors[0] as Neo4jError);
  }
  const fields = parsed.data?.fields;
  const values = parsed.data?.values;
  if (!Array.isArray(fields) || !Array.isArray(values)) {
    throw new DbError('internal', msg('The server answered without a result'));
  }
  const notifications = Array.isArray(parsed.notifications)
    ? parsed.notifications.flatMap((entry: unknown) => {
        const text = (entry as { description?: unknown } | null)?.description;
        return typeof text === 'string' ? [text] : [];
      })
    : [];
  return {
    fields: fields.map(String),
    values: values as (readonly TypedValue[])[],
    notifications,
    counters:
      typeof parsed.counters === 'object' && parsed.counters !== null
        ? (parsed.counters as Record<string, unknown>)
        : undefined,
  };
}

/** One statement: the request body the Query API wants. */
export function requestBody(
  statement: string,
  parameters: Readonly<Record<string, unknown>> | undefined,
  readOnly: boolean,
): string {
  return JSON.stringify({
    statement,
    ...(parameters === undefined ? {} : { parameters }),
    includeCounters: true,
    accessMode: readOnly ? 'Read' : 'Write',
  });
}
