// A Grafana Loki server in the test process: the calls the driver makes, with answers the test
// sets. It records what it received, so a test can see the credentials, the tenant and the
// query that went over the wire.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly authorization: string | undefined;
  readonly tenant: string | undefined;
  readonly body: string;
}

export interface FakeLokiOptions {
  /** The `Authorization` header the server accepts; any other gets 401. Undefined accepts all. */
  readonly authorization?: string;
  /** The tenant the server requires in `X-Scope-OrgID`; another one gets 401. */
  readonly tenant?: string;
  readonly labels?: readonly string[];
  readonly values?: Readonly<Record<string, readonly string[]>>;
}

/** What to answer a query with, by a part of its text. */
export interface Answer {
  readonly status?: number;
  readonly body: string;
  /** Wait this long before answering (a slow query). */
  readonly holdMs?: number;
  /** Never answer: the client has to give up. */
  readonly hang?: boolean;
}

export class FakeLoki {
  readonly received: Received[] = [];
  readonly answers: { match: string; answer: Answer }[] = [];
  private server: Server | undefined;
  private readonly open = new Set<ServerResponse>();
  port = 0;

  constructor(private readonly options: FakeLokiOptions = {}) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => {
      this.server?.listen(0, '127.0.0.1', resolve);
    });
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const response of this.open) {
      response.destroy();
    }
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }

  /** Answers a query whose text contains `match` (the first match wins). */
  query(match: string, answer: Answer): void {
    this.answers.push({ match, answer });
  }

  last(): Received | undefined {
    return this.received.at(-1);
  }

  /** The calls of one path, in order. */
  calls(path: string): Received[] {
    return this.received.filter((entry) => entry.path === path);
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const body = await new Promise<string>((resolve) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    const url = new URL(request.url ?? '/', 'http://localhost');
    const query = Object.fromEntries(url.searchParams);
    if (request.method === 'POST' && body !== '') {
      Object.assign(query, Object.fromEntries(new URLSearchParams(body)));
    }
    const tenant = request.headers['x-scope-orgid'];
    const authorization = request.headers.authorization;
    this.received.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      query,
      authorization,
      tenant: typeof tenant === 'string' ? tenant : undefined,
      body,
    });
    if (
      (this.options.authorization !== undefined && authorization !== this.options.authorization) ||
      (this.options.tenant !== undefined && tenant !== this.options.tenant)
    ) {
      response.writeHead(401, { 'content-type': 'text/plain' });
      response.end('no org id or bad credentials');
      return;
    }
    this.open.add(response);
    response.on('close', () => this.open.delete(response));
    if (url.pathname === '/loki/api/v1/labels') {
      this.json(response, { status: 'success', data: this.options.labels ?? ['app', 'level'] });
      return;
    }
    const values = /^\/loki\/api\/v1\/label\/([^/]+)\/values$/u.exec(url.pathname);
    if (values !== null) {
      const name = decodeURIComponent(values[1] ?? '');
      this.json(response, { status: 'success', data: this.options.values?.[name] ?? [] });
      return;
    }
    if (url.pathname === '/loki/api/v1/query_range' || url.pathname === '/loki/api/v1/query') {
      await this.reply(response, query.query ?? '');
      return;
    }
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('404 page not found');
  }

  private json(response: ServerResponse, document: unknown): void {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(document));
  }

  private async reply(response: ServerResponse, text: string): Promise<void> {
    const found = this.answers.find((candidate) => text.includes(candidate.match))?.answer;
    if (found === undefined) {
      response.writeHead(400, { 'content-type': 'text/plain' });
      response.end(`no answer for: ${text}`);
      return;
    }
    if (found.hang === true) {
      return;
    }
    if (found.holdMs !== undefined) {
      await new Promise((resolve) => setTimeout(resolve, found.holdMs));
    }
    response.writeHead(found.status ?? 200, { 'content-type': 'application/json' });
    response.end(found.body);
  }
}

/** The answer of a log query: streams of `[ns, line]` pairs. */
export function streams(
  entries: readonly { labels: Record<string, string>; lines: readonly [string, string][] }[],
): string {
  return JSON.stringify({
    status: 'success',
    data: {
      resultType: 'streams',
      result: entries.map((entry) => ({ stream: entry.labels, values: entry.lines })),
    },
  });
}

/** The answer of a metric query over a range: series of `[seconds, "value"]` samples. */
export function matrix(
  series: readonly { metric: Record<string, string>; values: readonly [number, string][] }[],
): string {
  return JSON.stringify({ status: 'success', data: { resultType: 'matrix', result: series } });
}

/** The answer of an instant metric query. */
export function vector(
  samples: readonly { metric: Record<string, string>; value: [number, string] }[],
): string {
  return JSON.stringify({ status: 'success', data: { resultType: 'vector', result: samples } });
}
