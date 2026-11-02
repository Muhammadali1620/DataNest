// A Grafana Loki server in the test process: the calls the driver makes, with answers the test
// sets. It records what it received, so a test can see the credentials, the tenant and the
// query that went over the wire.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';

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

/** What the live view (WebSocket) endpoint does when a client connects. */
export interface TailScript {
  /** JSON messages to send, one frame each, `intervalMs` apart. */
  readonly messages: readonly string[];
  readonly intervalMs?: number;
  /** Close the stream after the last message; otherwise it stays open until the client leaves. */
  readonly close?: boolean;
  /** Send a ping before the first message; the client must answer with a pong. */
  readonly ping?: boolean;
  /** Send the first message in two fragments (a continuation frame). */
  readonly fragment?: boolean;
  /** Refuse the upgrade with this status and body instead. */
  readonly refuse?: { readonly status: number; readonly body: string };
}

/** A frame a server sends (never masked). */
export function serverFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([(fin ? 0x80 : 0) | opcode, length])
      : length < 65_536
        ? Buffer.from([(fin ? 0x80 : 0) | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const wide = Buffer.alloc(10);
            wide[0] = (fin ? 0x80 : 0) | opcode;
            wide[1] = 127;
            wide.writeBigUInt64BE(BigInt(length), 2);
            return wide;
          })();
  return Buffer.concat([head, payload]);
}

export class FakeLoki {
  readonly received: Received[] = [];
  readonly answers: { match: string; answer: Answer }[] = [];
  private server: Server | undefined;
  private readonly open = new Set<ServerResponse>();
  /** What the tail endpoint does; unset: it answers 404. */
  tailScript: TailScript | undefined;
  /** Frames the clients sent to the tail endpoint (opcode and unmasked payload). */
  readonly clientFrames: { opcode: number; payload: Buffer }[] = [];
  private readonly sockets = new Set<Socket>();
  port = 0;

  constructor(private readonly options: FakeLokiOptions = {}) {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server.on('upgrade', (request, socket: Socket) => {
      this.upgrade(request, socket);
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
    for (const socket of this.sockets) {
      socket.destroy();
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

  private upgrade(request: IncomingMessage, socket: Socket): void {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const tenant = request.headers['x-scope-orgid'];
    const authorization = request.headers.authorization;
    this.received.push({
      method: request.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      authorization,
      tenant: typeof tenant === 'string' ? tenant : undefined,
      body: '',
    });
    const script = this.tailScript;
    const refuse = (status: number, body: string): void => {
      socket.end(
        `HTTP/1.1 ${status} Refused\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`,
      );
    };
    if (
      (this.options.authorization !== undefined && authorization !== this.options.authorization) ||
      (this.options.tenant !== undefined && tenant !== this.options.tenant)
    ) {
      refuse(401, 'no org id or bad credentials');
      return;
    }
    if (url.pathname !== '/loki/api/v1/tail' || script === undefined) {
      refuse(404, '404 page not found');
      return;
    }
    if (script.refuse !== undefined) {
      refuse(script.refuse.status, script.refuse.body);
      return;
    }
    const key = request.headers['sec-websocket-key'];
    const accept = createHash('sha1')
      .update(`${typeof key === 'string' ? key : ''}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest('base64');
    this.sockets.add(socket);
    socket.on('close', () => {
      this.sockets.delete(socket);
    });
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      this.readClientFrames(chunk);
    });
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${accept}\r\n\r\n`,
    );
    void this.play(socket, script);
  }

  private readClientFrames(chunk: Buffer): void {
    // Enough of RFC 6455 for short frames from a client: always masked, under 126 bytes.
    let offset = 0;
    while (offset + 6 <= chunk.length) {
      const opcode = (chunk[offset] ?? 0) & 0x0f;
      const length = (chunk[offset + 1] ?? 0) & 0x7f;
      const mask = chunk.subarray(offset + 2, offset + 6);
      const payload = Buffer.from(chunk.subarray(offset + 6, offset + 6 + length));
      for (let index = 0; index < payload.length; index += 1) {
        payload[index] = (payload[index] ?? 0) ^ (mask[index % 4] ?? 0);
      }
      this.clientFrames.push({ opcode, payload });
      offset += 6 + length;
    }
  }

  private async play(socket: Socket, script: TailScript): Promise<void> {
    const pause = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, script.intervalMs ?? 10));
    };
    if (script.ping === true) {
      socket.write(serverFrame(0x9, Buffer.from('hi')));
      await pause();
    }
    let first = true;
    for (const message of script.messages) {
      if (socket.destroyed) {
        return;
      }
      const bytes = Buffer.from(message, 'utf8');
      if (first && script.fragment === true) {
        const cut = Math.floor(bytes.length / 2);
        socket.write(serverFrame(0x1, bytes.subarray(0, cut), false));
        await pause();
        socket.write(serverFrame(0x0, bytes.subarray(cut), true));
      } else {
        socket.write(serverFrame(0x1, bytes));
      }
      first = false;
      await pause();
    }
    if (script.close === true && !socket.destroyed) {
      socket.end(serverFrame(0x8, Buffer.alloc(0)));
    }
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
