// HTTP to an InfluxDB 2.x server on `node:http(s)`, nothing else. Answers are read as
// streams, so a result of a million points never sits in memory as one string; small
// calls (the bucket list, a health check) read the whole body, up to a limit.
// Written from the public API description (clean-room).

import type { Agent as HttpAgent } from 'node:http';
import { request as httpRequest } from 'node:http';
import type { Agent as HttpsAgent } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import type { TlsMaterial } from '../common/tls';
import { agentFor, targetUrl } from '../libsql/hrana';

export { agentFor, targetUrl };

/** The largest body of a call that is read whole (the bucket list and the like). */
export const MAX_BODY_BYTES = 16 * 1024 * 1024;

export interface InfluxTarget {
  readonly url: URL;
  /** The API token; sent as `Authorization: Token …`. */
  readonly token?: string;
  readonly tls?: TlsMaterial | undefined;
}

export interface InfluxRequest {
  readonly method: 'GET' | 'POST';
  /** Path with the leading slash, e.g. `/api/v2/query`. */
  readonly path: string;
  readonly query?: Readonly<Record<string, string>>;
  readonly body?: string;
  readonly contentType?: string;
  readonly accept?: string;
  readonly signal?: AbortSignal | undefined;
}

export interface InfluxResponse {
  readonly status: number;
  readonly body: AsyncIterable<Buffer>;
}

/** Sends a request and hands back the status and the body as a stream. */
export function send(
  target: InfluxTarget,
  agent: HttpAgent | HttpsAgent,
  input: InfluxRequest,
): Promise<InfluxResponse> {
  return new Promise<InfluxResponse>((resolve, reject) => {
    const url = new URL(target.url);
    url.pathname = input.path;
    for (const [key, value] of Object.entries(input.query ?? {})) {
      url.searchParams.set(key, value);
    }
    const open = url.protocol === 'https:' ? httpsRequest : httpRequest;
    const request = open(
      url,
      {
        method: input.method,
        agent,
        headers: {
          accept: input.accept ?? 'application/json',
          ...(input.body === undefined
            ? {}
            : {
                'content-type': input.contentType ?? 'application/json',
                'content-length': Buffer.byteLength(input.body),
              }),
          ...(target.token === undefined ? {} : { authorization: `Token ${target.token}` }),
        },
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      },
      (response) => {
        // An abort after enough rows were read destroys the stream; nobody listens by then.
        response.on('error', () => undefined);
        resolve({ status: response.statusCode ?? 0, body: response });
      },
    );
    request.on('error', reject);
    request.end(input.body);
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
      throw new DbError('unsupported', msg('The answer of the server is larger than 16 MB'));
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}
