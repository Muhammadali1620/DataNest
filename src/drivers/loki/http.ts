// HTTP to a Grafana Loki server on `node:http(s)`, nothing else (V13.25). A tenant goes in the
// `X-Scope-OrgID` header; a user and password are basic authentication, a password alone is a
// bearer token. Written from the public API description (clean-room).

import type { Agent as HttpAgent } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { TlsMaterial } from '../common/tls';
import { agentFor, targetUrl } from '../libsql/hrana';

export { agentFor, targetUrl };

/** The largest answer that is read: more lines than this belong to a narrower query. */
export const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Past this many characters a query goes in the body, not in the address. */
export const MAX_QUERY_STRING = 4000;

export interface LokiTarget {
  readonly url: URL;
  /** Basic authentication when a user is set; a bearer token when only a password is. */
  readonly user?: string;
  readonly secret?: string;
  /** The tenant (`X-Scope-OrgID`). */
  readonly tenant?: string;
  readonly tls?: TlsMaterial | undefined;
}

export interface LokiRequest {
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal | undefined;
}

export interface LokiResponse {
  readonly status: number;
  readonly body: AsyncIterable<Buffer>;
}

/** The authorization header of a target, if it needs one. */
export function authorizationOf(target: LokiTarget): string | undefined {
  if (target.secret === undefined || target.secret === '') {
    return undefined;
  }
  if (target.user !== undefined && target.user !== '') {
    return `Basic ${Buffer.from(`${target.user}:${target.secret}`, 'utf8').toString('base64')}`;
  }
  return `Bearer ${target.secret}`;
}

/**
 * Sends a request and hands back the status and the body as a stream. A long query goes as a
 * form in a POST, which Loki reads the same as the address.
 */
export function send(
  target: LokiTarget,
  agent: HttpAgent | HttpsAgent,
  input: LokiRequest,
): Promise<LokiResponse> {
  return new Promise<LokiResponse>((resolve, reject) => {
    const url = new URL(target.url);
    url.pathname = input.path;
    const params = new URLSearchParams(input.query ?? {});
    const long = params.toString().length > MAX_QUERY_STRING;
    if (!long) {
      url.search = params.toString();
    }
    const authorization = authorizationOf(target);
    const body = long ? params.toString() : undefined;
    const open = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = open(
      url,
      {
        method: long ? 'POST' : 'GET',
        agent,
        headers: {
          accept: 'application/json',
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/x-www-form-urlencoded',
                'content-length': Buffer.byteLength(body),
              }),
          ...(authorization === undefined ? {} : { authorization }),
          ...(target.tenant === undefined || target.tenant === ''
            ? {}
            : { 'x-scope-orgid': target.tenant }),
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      (response) => {
        // An abort after enough was read destroys the stream; nobody listens by then.
        response.on('error', () => undefined);
        resolve({ status: response.statusCode ?? 0, body: response });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

/** Reads a body to the end as text; a body past the limit is an error, not a truncation. */
export async function readText(
  body: AsyncIterable<Buffer>,
  limit = MAX_BODY_BYTES,
): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of body) {
    size += chunk.length;
    if (size > limit) {
      throw new DbError(
        'unsupported',
        msg('The answer of the server is larger than 64 MB: narrow the query or lower the limit'),
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
