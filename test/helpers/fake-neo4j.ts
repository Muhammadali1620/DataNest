// A Neo4j Query API in the test process: a plain HTTP server that answers each statement from
// a script, so the driver can be tested without a database (the real server has its own
// tests in test/integration/neo4j). Values are tagged the way the server tags them.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** One request as the server saw it. */
export interface Seen {
  readonly path: string;
  readonly authorization: string | undefined;
  readonly accept: string | undefined;
  readonly statement: string;
  readonly parameters: Record<string, unknown> | undefined;
  readonly accessMode: string | undefined;
}

export interface Reply {
  readonly status?: number;
  readonly body?: unknown;
  /** Raw text instead of JSON. */
  readonly text?: string;
  /** Never answers; the client has to give up. */
  readonly hang?: boolean;
  /** Waits this long before answering. */
  readonly delayMs?: number;
}

export type Script = (seen: Seen) => Reply;

export const int = (value: number | string): { $type: string; _value: string } => ({
  $type: 'Integer',
  _value: String(value),
});
export const str = (value: string): { $type: string; _value: string } => ({
  $type: 'String',
  _value: value,
});
export const bool = (value: boolean): { $type: string; _value: boolean } => ({
  $type: 'Boolean',
  _value: value,
});
export const list = (...items: unknown[]): { $type: string; _value: unknown[] } => ({
  $type: 'List',
  _value: items,
});

/** An answer with the given fields and rows. */
export function rows(
  fields: readonly string[],
  values: readonly (readonly unknown[])[],
  extra: Record<string, unknown> = {},
): Reply {
  return { status: 202, body: { data: { fields, values }, ...extra } };
}

export function failure(status: number, code: string, message: string): Reply {
  return { status, body: { errors: [{ code, message }] } };
}

export class FakeNeo4j {
  readonly seen: Seen[] = [];
  private server: Server | undefined;
  port = 0;

  constructor(private script: Script) {}

  /** Replaces the script, e.g. between the open of a session and the statements. */
  answer(script: Script): void {
    this.script = script;
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      this.handle(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server === undefined) {
      return;
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) =>
      server.close(() => {
        resolve();
      }),
    );
  }

  private handle(request: IncomingMessage, response: ServerResponse): void {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        statement: string;
        parameters?: Record<string, unknown>;
        accessMode?: string;
      };
      const seen: Seen = {
        path: request.url ?? '',
        authorization: request.headers.authorization,
        accept: request.headers.accept,
        statement: body.statement,
        parameters: body.parameters,
        accessMode: body.accessMode,
      };
      this.seen.push(seen);
      const reply = this.script(seen);
      if (reply.hang === true) {
        return;
      }
      const send = (): void => {
        response.statusCode = reply.status ?? 202;
        response.setHeader('content-type', 'application/json');
        response.end(
          reply.text ?? JSON.stringify(reply.body ?? { data: { fields: [], values: [] } }),
        );
      };
      if (reply.delayMs === undefined) {
        send();
      } else {
        setTimeout(send, reply.delayMs);
      }
    });
  }
}
