// The Hrana protocol over HTTP, as libSQL servers (sqld, Turso) speak it: JSON posted to
// `/v3/pipeline`, answered with one result per request. Written from the public protocol
// description; only `node:http(s)` is used. A stream (what the server calls the session
// behind a baton) keeps its connection state between requests, so BEGIN … COMMIT and
// temporary tables work; the server hands out a new baton with every answer.

import { Agent as HttpAgent, request as httpRequest } from 'node:http';
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import { identityCheck, sniName, type TlsMaterial } from '../common/tls';
import { fromHttpStatus, type HranaError, toLibsqlDbError } from './errors';
import type { HranaValue } from './values';

/** The largest answer read into memory; a bigger result asks for a LIMIT instead. */
export const MAX_RESPONSE_BYTES = 256 * 1024 * 1024;

export interface HranaColumn {
  readonly name: string | null;
  readonly decltype: string | null;
}

export interface HranaStatement {
  readonly sql: string;
  readonly args?: readonly HranaValue[];
  readonly want_rows: boolean;
}

export interface HranaExecuteResult {
  readonly cols: readonly HranaColumn[];
  readonly rows: readonly (readonly unknown[])[];
  readonly affected_row_count: number;
}

export type HranaRequest =
  | { readonly type: 'execute'; readonly stmt: HranaStatement }
  | { readonly type: 'get_autocommit' }
  | { readonly type: 'close' };

/** One answer of a pipeline: the response of the request, or the error it ended with. */
export type HranaOutcome =
  | { readonly type: 'ok'; readonly response: Record<string, unknown> }
  | { readonly type: 'error'; readonly error: HranaError };

/** The server forgot the stream (idle for too long, restarted): its state is gone. */
export class StreamExpired extends Error {
  constructor() {
    super('The stream expired on the server');
    this.name = 'StreamExpired';
  }
}

export interface HranaTarget {
  readonly url: URL;
  readonly token?: string;
  readonly tls?: TlsMaterial | undefined;
}

/** The scheme and address of a server from what the form holds. */
export function targetUrl(host: string | undefined, port: number | undefined, tls: boolean): URL {
  const text = (host ?? '').trim() === '' ? 'localhost' : (host ?? '').trim();
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.exec(text);
  if (withScheme !== null) {
    const parsed = new URL(text);
    const secure = ['https:', 'libsql:', 'wss:'].includes(parsed.protocol);
    const url = new URL(`${secure ? 'https' : 'http'}://${parsed.host}`);
    if (parsed.port === '' && port !== undefined) {
      url.port = String(port);
    }
    return url;
  }
  const name = text.includes(':') && !text.startsWith('[') ? `[${text}]` : text;
  const chosen = port ?? (tls ? 443 : 8080);
  return new URL(`${tls ? 'https' : 'http'}://${name}:${chosen}`);
}

/** The HTTP agent: TLS checks as the connection asks, against the server's real name. */
export function agentFor(url: URL, tls: TlsMaterial | undefined): HttpAgent | HttpsAgent {
  if (url.protocol !== 'https:') {
    return new HttpAgent({ keepAlive: true });
  }
  if (tls === undefined) {
    return new HttpsAgent({ keepAlive: true });
  }
  const servername = sniName(tls.serverName);
  return new HttpsAgent({
    keepAlive: true,
    ...(tls.ca === undefined ? {} : { ca: tls.ca }),
    ...(tls.cert === undefined ? {} : { cert: tls.cert }),
    ...(tls.key === undefined ? {} : { key: tls.key }),
    rejectUnauthorized: tls.mode !== 'require',
    ...(servername === undefined ? {} : { servername }),
    checkServerIdentity: identityCheck(tls),
  });
}

interface HttpAnswer {
  readonly status: number;
  readonly body: string;
}

/** POSTs JSON; the signal aborts the request, and with it whatever the server was doing. */
export function postJson(
  url: URL,
  body: string,
  options: {
    readonly token: string | undefined;
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
          accept: 'application/json',
          ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
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

function isExpiry(error: HranaError): boolean {
  const code = typeof error.code === 'string' ? error.code : '';
  const text = typeof error.message === 'string' ? error.message : '';
  return (
    code === 'STREAM_EXPIRED' || /invalid baton|stream.*(expired|not found|closed)/iu.test(text)
  );
}

/**
 * One server-side stream. Requests go one at a time; the baton of each answer is sent
 * with the next request. `readOnly` makes the first request of a fresh stream turn on
 * `query_only`, which the server then enforces for as long as the stream lives. A server
 * that does not take the pragma (sqld answers "unsupported statement") is not asked again:
 * the statements DataNest itself refuses on a read-only connection are then the only
 * guard, and `queryOnlyRefused` tells the session so.
 */
export class HranaStream {
  /** `v3` has `get_autocommit`; an older server falls back to `v2` on the first request. */
  version: 'v3' | 'v2' = 'v3';
  /** True once the server has turned `PRAGMA query_only` down. */
  queryOnlyRefused = false;
  private baton: string | undefined;
  private base: URL;
  private readonly agent: HttpAgent | HttpsAgent;

  constructor(
    private readonly target: HranaTarget,
    private readonly readOnly: boolean,
  ) {
    this.base = target.url;
    this.agent = agentFor(target.url, target.tls);
  }

  /** Whether the server tells if a transaction is open. */
  get reportsTransactions(): boolean {
    return this.version === 'v3';
  }

  /** Forgets the stream (after an abort, the baton is of no use any more). */
  reset(): void {
    this.baton = undefined;
    this.base = this.target.url;
  }

  /** Runs the requests in order; the results line up with them (a skipped one is absent). */
  async send(
    requests: readonly HranaRequest[],
    signal?: AbortSignal,
  ): Promise<(HranaOutcome | undefined)[]> {
    const fresh = this.baton === undefined;
    const pragma: HranaRequest[] =
      fresh && this.readOnly && !this.queryOnlyRefused
        ? [
            {
              type: 'execute',
              stmt: { sql: 'PRAGMA query_only = 1', want_rows: false },
            },
          ]
        : [];
    const wanted =
      this.version === 'v3' ? requests : requests.filter((r) => r.type !== 'get_autocommit');
    const outcomes = await this.post([...pragma, ...wanted], signal);
    if (pragma.length > 0) {
      const first = outcomes[0];
      if (first?.type === 'error') {
        this.queryOnlyRefused = true;
        // A server that stops at the first error has not run the requests that mattered.
        if (outcomes.length - pragma.length < wanted.length) {
          return await this.send(requests, signal);
        }
      }
    }
    const results = outcomes.slice(pragma.length);
    if (this.version === 'v3') {
      return requests.map((_request, index) => results[index]);
    }
    let at = 0;
    return requests.map((request) =>
      request.type === 'get_autocommit' ? undefined : results[at++],
    );
  }

  /** Closes the stream on the server; failures do not matter, the server expires it anyway. */
  async close(): Promise<void> {
    if (this.baton === undefined) {
      return;
    }
    try {
      await this.post([{ type: 'close' }], AbortSignal.timeout(3000));
    } catch {
      // Nothing to recover: the connection is going away.
    }
    this.reset();
    this.agent.destroy();
  }

  private async post(
    requests: readonly HranaRequest[],
    signal: AbortSignal | undefined,
  ): Promise<(HranaOutcome | undefined)[]> {
    const body = JSON.stringify({ baton: this.baton ?? null, requests });
    let answer: HttpAnswer;
    try {
      answer = await postJson(new URL(`/${this.version}/pipeline`, this.base), body, {
        token: this.target.token,
        agent: this.agent,
        signal,
      });
    } catch (error) {
      if (signal?.aborted === true) {
        this.reset();
      }
      throw toLibsqlDbError(error);
    }
    if (answer.status === 404 && this.version === 'v3' && this.baton === undefined) {
      // A server from before Hrana 3.
      this.version = 'v2';
      return await this.post(
        requests.filter((request) => request.type !== 'get_autocommit'),
        signal,
      );
    }
    if (answer.status < 200 || answer.status >= 300) {
      const error = fromHttpStatusBody(answer);
      if (this.baton !== undefined && isExpiry(error.raw)) {
        this.reset();
        throw new StreamExpired();
      }
      throw error.error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(answer.body);
    } catch {
      throw new DbError('internal', msg('The server sent an answer that is not JSON'));
    }
    const document = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
      baton?: unknown;
      base_url?: unknown;
      results?: unknown;
    };
    this.baton = typeof document.baton === 'string' ? document.baton : undefined;
    if (typeof document.base_url === 'string' && document.base_url !== '') {
      try {
        this.base = new URL(document.base_url);
      } catch {
        // Keep the address that works.
      }
    }
    return Array.isArray(document.results) ? (document.results as HranaOutcome[]) : [];
  }
}

function fromHttpStatusBody(answer: HttpAnswer): { error: DbError; raw: HranaError } {
  let raw: HranaError = {};
  try {
    const parsed: unknown = JSON.parse(answer.body);
    if (typeof parsed === 'object' && parsed !== null) {
      raw = parsed;
    }
  } catch {
    raw = { message: answer.body.slice(0, 500) };
  }
  return { error: fromHttpStatus(answer.status, answer.body), raw };
}
