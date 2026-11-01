// A libSQL server in a few lines, for the tests of the libsql driver (V13.17): the Hrana
// pipeline over HTTP, with streams kept by baton, a transaction flag that BEGIN, COMMIT and
// ROLLBACK flip, an auth token, and switches for the failures a real server shows (a
// forgotten stream, an old protocol version, a slow statement).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeStatement {
  readonly sql: string;
  readonly args: readonly unknown[];
  readonly want_rows?: boolean;
}

export interface FakeResult {
  readonly cols?: readonly { name: string | null; decltype: string | null }[];
  readonly rows?: readonly (readonly unknown[])[];
  readonly affected?: number;
  /** The statement fails with this error. */
  readonly error?: { message: string; code?: string };
}

export interface PipelineRecord {
  readonly path: string;
  readonly baton: string | null;
  readonly authorization: string | undefined;
  readonly requests: readonly { type: string; stmt?: FakeStatement }[];
}

export interface FakeHranaOptions {
  /** Bearer token the server wants; others get 401. */
  readonly token?: string;
  /** Hrana 3 is `/v3/pipeline`; false answers 404 there, like a server from before. */
  readonly v3?: boolean;
  /** Answers a statement; the default knows `SELECT 1`, transactions and little else. */
  readonly handler?: (
    statement: FakeStatement,
    stream: FakeStream,
  ) => FakeResult | Promise<FakeResult>;
}

/** State behind a baton. */
export interface FakeStream {
  readonly id: number;
  autocommit: boolean;
  readonly statements: string[];
}

const INTEGER = (value: number): { type: 'integer'; value: string } => ({
  type: 'integer',
  value: String(value),
});

export class FakeHrana {
  readonly records: PipelineRecord[] = [];
  readonly streams = new Map<string, FakeStream>();
  /** Statements that arrive, in order, over all streams. */
  readonly statements: string[] = [];
  /** Statements the server holds this long before it answers (for cancel tests). */
  delayMs = 0;
  /** The next pipeline answers this HTTP status and text instead. */
  failNext: { status: number; body: string } | undefined;
  private server: Server | undefined;
  private nextStream = 1;
  private batons = 0;
  /** Aborted requests the server noticed. */
  aborted = 0;

  constructor(private readonly options: FakeHranaOptions = {}) {}

  async start(): Promise<number> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    return (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server?.close(() => {
        resolve();
      });
    });
  }

  /** The server forgets every stream (a restart, or an idle timeout). */
  expireAll(): void {
    this.streams.clear();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    request.on('aborted', () => {
      this.aborted += 1;
    });
    response.on('close', () => {
      if (!response.writableEnded) {
        this.aborted += 1;
      }
    });
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(chunk as Buffer);
    }
    const path = request.url ?? '';
    const send = (status: number, body: string): void => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(body);
    };
    if (this.options.token !== undefined) {
      if (request.headers.authorization !== `Bearer ${this.options.token}`) {
        send(401, JSON.stringify({ message: 'Authorization failed: invalid token' }));
        return;
      }
    }
    const v3 = this.options.v3 ?? true;
    if (path !== '/v2/pipeline' && !(v3 && path === '/v3/pipeline')) {
      send(404, 'Not found');
      return;
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      baton: string | null;
      requests: { type: string; stmt?: { sql: string; args?: unknown[]; want_rows?: boolean } }[];
    };
    this.records.push({
      path,
      baton: body.baton,
      authorization: request.headers.authorization,
      requests: body.requests.map((r) => ({
        type: r.type,
        ...(r.stmt === undefined
          ? {}
          : { stmt: { sql: r.stmt.sql, args: r.stmt.args ?? [], want_rows: r.stmt.want_rows } }),
      })),
    });
    if (this.failNext !== undefined) {
      const { status, body: text } = this.failNext;
      this.failNext = undefined;
      send(status, text);
      return;
    }
    let stream: FakeStream | undefined;
    if (body.baton === null) {
      stream = { id: this.nextStream++, autocommit: true, statements: [] };
    } else {
      stream = this.streams.get(body.baton);
      if (stream === undefined) {
        send(400, 'Received an invalid baton');
        return;
      }
    }
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    const results: unknown[] = [];
    let closed = false;
    for (const item of body.requests) {
      if (item.type === 'close') {
        closed = true;
        results.push({ type: 'ok', response: { type: 'close' } });
      } else if (item.type === 'get_autocommit') {
        results.push({
          type: 'ok',
          response: { type: 'get_autocommit', is_autocommit: stream.autocommit },
        });
      } else if (item.type === 'execute' && item.stmt !== undefined) {
        results.push(await this.execute(item.stmt, stream));
      } else {
        results.push({ type: 'error', error: { message: `unknown request ${item.type}` } });
      }
    }
    if (body.baton !== null) {
      // The old baton is spent: every answer hands out a new one.
      this.streams.delete(body.baton);
    }
    if (closed) {
      send(200, JSON.stringify({ baton: null, base_url: null, results }));
      return;
    }
    this.batons += 1;
    const baton = `baton-${stream.id}-${this.batons}`;
    this.streams.set(baton, stream);
    send(200, JSON.stringify({ baton, base_url: null, results }));
  }

  private async execute(
    raw: { sql: string; args?: unknown[]; want_rows?: boolean },
    stream: FakeStream,
  ): Promise<unknown> {
    const statement: FakeStatement = {
      sql: raw.sql,
      args: raw.args ?? [],
      ...(raw.want_rows === undefined ? {} : { want_rows: raw.want_rows }),
    };
    this.statements.push(statement.sql);
    stream.statements.push(statement.sql);
    const keyword = statement.sql.trim().split(/\s+/u)[0]?.toUpperCase() ?? '';
    let answer: FakeResult;
    if (keyword === 'BEGIN') {
      stream.autocommit = false;
      answer = {};
    } else if (keyword === 'COMMIT' || keyword === 'ROLLBACK') {
      stream.autocommit = true;
      answer = {};
    } else if (this.options.handler !== undefined) {
      answer = await this.options.handler(statement, stream);
    } else if (/^SELECT 1\b/iu.test(statement.sql)) {
      answer = { cols: [{ name: '1', decltype: null }], rows: [[INTEGER(1)]] };
    } else {
      answer = {};
    }
    if (answer.error !== undefined) {
      return { type: 'error', error: answer.error };
    }
    return {
      type: 'ok',
      response: {
        type: 'execute',
        result: {
          cols: answer.cols ?? [],
          rows: answer.rows ?? [],
          affected_row_count: answer.affected ?? 0,
          last_insert_rowid: null,
        },
      },
    };
  }
}
