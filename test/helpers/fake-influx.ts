// An InfluxDB 2.x server in the test process: the three calls the driver makes, with
// answers the test sets. It records what it received, so a test can see the token, the
// organization and the query that went over the wire.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface Received {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly authorization: string | undefined;
  readonly body: string;
}

export interface FakeInfluxOptions {
  /** The token the server accepts; any other gets 401. Undefined accepts everything. */
  readonly token?: string;
  readonly buckets?: readonly { name: string; type?: string }[];
}

/** What to answer a query with, by a part of its text. */
export interface Answer {
  readonly status?: number;
  readonly body: string;
  /** Sent in pieces with this pause between them (a slow, long answer). */
  readonly chunks?: readonly string[];
  readonly holdMs?: number;
}

export class FakeInflux {
  readonly received: Received[] = [];
  readonly fluxAnswers: { match: string; answer: Answer }[] = [];
  readonly influxqlAnswers: { match: string; answer: Answer }[] = [];
  private server: Server | undefined;
  private readonly sockets = new Set<ServerResponse>();
  port = 0;

  constructor(private readonly options: FakeInfluxOptions = {}) {}

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
    for (const response of this.sockets) {
      response.destroy();
    }
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }

  flux(match: string, answer: Answer): void {
    this.fluxAnswers.push({ match, answer });
  }

  influxql(match: string, answer: Answer): void {
    this.influxqlAnswers.push({ match, answer });
  }

  last(): Received | undefined {
    return this.received.at(-1);
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
    const authorization = request.headers.authorization;
    this.received.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization,
      body,
    });
    if (this.options.token !== undefined && authorization !== `Token ${this.options.token}`) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'unauthorized', message: 'unauthorized access' }));
      return;
    }
    if (url.pathname === '/api/v2/buckets') {
      const all = this.options.buckets ?? [{ name: 'metrics', type: 'user' }];
      const offset = Number(url.searchParams.get('offset') ?? '0');
      const limit = Number(url.searchParams.get('limit') ?? '20');
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ buckets: all.slice(offset, offset + limit) }));
      return;
    }
    if (url.pathname === '/api/v2/query') {
      const query = (JSON.parse(body) as { query: string }).query;
      await this.reply(response, this.fluxAnswers, query, 'text/csv; charset=utf-8');
      return;
    }
    if (url.pathname === '/query') {
      const q = new URLSearchParams(body).get('q') ?? '';
      await this.reply(response, this.influxqlAnswers, q, 'application/json');
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: 'not found', message: 'path not found' }));
  }

  private async reply(
    response: ServerResponse,
    answers: readonly { match: string; answer: Answer }[],
    text: string,
    contentType: string,
  ): Promise<void> {
    const found = answers.find((candidate) => text.includes(candidate.match))?.answer;
    if (found === undefined) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ code: 'invalid', message: `no answer for: ${text}` }));
      return;
    }
    response.writeHead(found.status ?? 200, { 'content-type': contentType });
    this.sockets.add(response);
    response.on('close', () => this.sockets.delete(response));
    if (found.chunks === undefined) {
      response.end(found.body);
      return;
    }
    for (const chunk of found.chunks) {
      response.write(chunk);
      await new Promise((resolve) => setTimeout(resolve, found.holdMs ?? 0));
    }
    response.end();
  }
}

/** A Flux answer with one table: annotations, a header and rows, then the blank line. */
export function fluxTable(
  header: readonly string[],
  datatypes: readonly string[],
  rows: readonly (readonly string[])[],
  defaults?: readonly string[],
): string {
  const line = (cells: readonly string[]): string => `,${cells.join(',')}`;
  return [
    `#datatype,${datatypes.join(',')}`,
    `#default,${(defaults ?? datatypes.map(() => '')).join(',')}`,
    line(header),
    ...rows.map((row) => line(row)),
    '',
    '',
  ].join('\r\n');
}
