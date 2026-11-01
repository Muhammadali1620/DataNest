// A stand-in for the Cassandra driver's client (V13.22): tests script what the server answers,
// page by page, and read back every request the session made.

import { types } from 'cassandra-driver';
import type {
  ClientFactory,
  CqlClient,
  CqlExecuteOptions,
  CqlResult,
} from '../../src/drivers/cassandra/session';

/** A column as the driver describes it. */
export function column(name: string, code: number, info?: unknown) {
  return { name, type: info === undefined ? { code } : { code, info } };
}

export const TYPE = types.dataTypes;

/** A result with the given columns and rows (arrays of values). */
export function result(
  columns: ReturnType<typeof column>[],
  rows: unknown[][],
  extra: Partial<CqlResult> = {},
): CqlResult {
  return {
    columns,
    rows: rows.map((values) => ({ values: () => values })),
    ...extra,
  };
}

export interface Request {
  readonly query: string;
  readonly params: readonly unknown[];
  readonly options: CqlExecuteOptions;
}

export class FakeCassandraClient implements CqlClient {
  readonly requests: Request[] = [];
  connected = false;
  shutdowns = 0;
  /** Answers by exact query text; a function sees the page state of the request. */
  readonly answers = new Map<
    string,
    CqlResult | Error | ((request: Request) => CqlResult | Error)
  >();
  /** Set to make `connect` fail. */
  connectError: Error | undefined;
  /** Runs inside `execute` before it answers (to cancel in flight, to delay). */
  onExecute: ((request: Request) => Promise<void> | void) | undefined;

  connect(): Promise<void> {
    if (this.connectError !== undefined) {
      return Promise.reject(this.connectError);
    }
    this.connected = true;
    return Promise.resolve();
  }

  async execute(
    query: string,
    params: readonly unknown[],
    options: CqlExecuteOptions,
  ): Promise<CqlResult> {
    const request = { query, params, options };
    this.requests.push(request);
    await this.onExecute?.(request);
    const answer = this.answers.get(query);
    if (answer === undefined) {
      return { columns: [], rows: [] };
    }
    const value = typeof answer === 'function' ? answer(request) : answer;

    if (value instanceof Error) {
      throw value;
    }
    return value;
  }

  shutdown(): Promise<void> {
    this.shutdowns += 1;
    return Promise.resolve();
  }
}

/** A client factory that hands out one fake and remembers the options it was built with. */
export function factoryFor(client: FakeCassandraClient): {
  readonly factory: ClientFactory;
  readonly options: () => Record<string, unknown>;
} {
  let seen: Record<string, unknown> = {};
  return {
    factory: (options) => {
      seen = options as unknown as Record<string, unknown>;
      return client;
    },
    options: () => seen,
  };
}

/** An error shaped like the driver's own, which the session recognizes by name and code. */
export function driverError(name: string, message: string, code?: number): Error {
  return Object.assign(new Error(message), { name, ...(code === undefined ? {} : { code }) });
}
