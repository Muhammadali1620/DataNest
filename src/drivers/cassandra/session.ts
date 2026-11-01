import { Client, type ClientOptions, policies, types } from 'cassandra-driver';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_PORTS,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import type { CellValue } from '../../shared/cell-value';
import { identityCheck, sniName, tlsFailure, tlsMaterial } from '../common/tls';
import type { ExecuteEvent, ExecuteOptions, ResultColumn, Session } from '../driver';
import { skipOf } from './dialect';
import { toCassandraDbError } from './errors';
import { CassandraMetadata } from './metadata';
import { fromCassandra, typeName } from './values';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/** Rows the server sends per page when nothing asks for fewer. */
export const PAGE_SIZE = 1000;

/** A metadata question never reads more than this many rows. */
const METADATA_ROW_CAP = 20_000;

/** The part of a driver `ResultSet` the session reads. */
export interface CqlResult {
  readonly columns?: readonly { readonly name: string; readonly type: unknown }[] | null;
  /** Absent for a statement that returns no rows (DDL, writes). */
  readonly rows?: readonly { values(): unknown[] }[];
  readonly pageState?: string | null;
  readonly info?: { readonly warnings?: readonly string[] | null };
}

export interface CqlExecuteOptions {
  readonly fetchSize: number;
  readonly pageState?: string;
  readonly prepare: false;
  readonly consistency?: number;
}

/** The part of the driver `Client` the session uses, so tests can stand in for it. */
export interface CqlClient {
  connect(): Promise<void>;
  execute(
    query: string,
    params: readonly unknown[],
    options: CqlExecuteOptions,
  ): Promise<CqlResult>;
  shutdown(): Promise<void>;
}

export type ClientFactory = (options: ClientOptions) => CqlClient;

const realClient: ClientFactory = (options) => {
  const client = new Client(options);
  return {
    connect: () => client.connect(),
    execute: (query, params, executeOptions) => client.execute(query, [...params], executeOptions),
    shutdown: () => client.shutdown(),
  };
};

/** The driver's base class; its typings call it an interface, but it checks for the class. */
const AddressTranslatorBase = (
  policies.addressResolution as unknown as { AddressTranslator: new () => object }
).AddressTranslator;

/** Where every node of the cluster is reached: the one address the user gave. */
class SingleEndpoint extends AddressTranslatorBase {
  constructor(private readonly endpoint: string) {
    super();
  }

  translate(_address: string, _port: number, callback: (endPoint: string) => void): void {
    callback(this.endpoint);
  }
}

type Translator = NonNullable<NonNullable<ClientOptions['policies']>['addressResolution']>;

function singleEndpoint(endpoint: string): Translator {
  return new SingleEndpoint(endpoint);
}

/** The consistency levels by name, as `CONSISTENCY` takes them. */
export function consistencyByName(name: string): number | undefined {
  const key = name.trim().replace(/[_\s]+(.)/gu, (_all, char: string) => char.toUpperCase());
  const levels = types.consistencies as unknown as Record<string, number>;
  const found = Object.keys(levels).find((level) => level.toLowerCase() === key.toLowerCase());
  return found === undefined ? undefined : levels[found];
}

/** The name of a level, as cqlsh prints it: `LOCAL_QUORUM`. */
export function consistencyName(level: number): string {
  const levels = types.consistencies as unknown as Record<string, number>;
  const name = Object.keys(levels).find((key) => levels[key] === level) ?? String(level);
  return name.replace(/([A-Z])/gu, '_$1').toUpperCase();
}

const CONSISTENCY_COMMAND = /^\s*(SERIAL\s+)?CONSISTENCY(?:\s+([A-Za-z_]+))?\s*;?\s*$/iu;

export async function openCassandraSession(config: ResolvedConnectionConfig): Promise<Session> {
  return await openCassandraSessionWith(config, realClient);
}

export async function openCassandraSessionWith(
  config: ResolvedConnectionConfig,
  makeClient: ClientFactory,
): Promise<Session> {
  const tls = await tlsMaterial(config);
  const host = (config.host ?? 'localhost').trim();
  const port = config.port ?? DEFAULT_PORTS.cassandra ?? 9042;
  const endpoint = `${host}:${port}`;
  const servername = tls === undefined ? undefined : sniName(tls.serverName);
  const keyspace = (config.database ?? '').trim();
  const options: ClientOptions = {
    contactPoints: [endpoint],
    // One access point serves for the whole cluster (a tunnel, a container, a load balancer),
    // so no data center has to be named and no node address needs to be reachable.
    policies: {
      loadBalancing: new policies.loadBalancing.RoundRobinPolicy(),
      addressResolution: singleEndpoint(endpoint),
    },
    ...(config.user === undefined || config.user === ''
      ? {}
      : { credentials: { username: config.user, password: config.password ?? '' } }),
    ...(keyspace === '' ? {} : { keyspace }),
    ...(tls === undefined
      ? {}
      : {
          sslOptions: {
            ...(tls.ca === undefined ? {} : { ca: tls.ca }),
            ...(tls.cert === undefined ? {} : { cert: tls.cert }),
            ...(tls.key === undefined ? {} : { key: tls.key }),
            rejectUnauthorized: tls.mode !== 'require',
            ...(servername === undefined ? {} : { servername }),
            checkServerIdentity: identityCheck(tls),
          },
        }),
    socketOptions: {
      connectTimeout: (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000,
      readTimeout: (config.options?.queryTimeout ?? 0) * 1000,
      keepAlive: true,
    },
    queryOptions: { prepare: false, fetchSize: PAGE_SIZE },
  };
  const client = makeClient(options);
  const session = new CassandraSession(client);
  try {
    await client.connect();
  } catch (error) {
    await session.close();
    throw tlsFailure(error, tls?.serverName ?? '') ?? toCassandraDbError(error);
  }
  return session;
}

function resultColumns(result: CqlResult): ResultColumn[] {
  return (result.columns ?? []).map((column) => {
    const type = typeName(column.type);
    return type === undefined ? { name: column.name } : { name: column.name, dataType: type };
  });
}

class CassandraSession implements Session {
  readonly metadata: CassandraMetadata;
  /** Requests are sent one at a time, as every other session does. */
  private tail: Promise<void> = Promise.resolve();
  private cancelled = false;
  private closed = false;
  private consistency: number | undefined;

  constructor(private readonly client: CqlClient) {
    this.metadata = new CassandraMetadata(this);
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /** Rows of a parameterized read; used by metadata lookups. */
  async queryRows(cql: string, parameters: readonly unknown[] = []): Promise<CellValue[][]> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    const release = await this.acquire();
    try {
      const rows: CellValue[][] = [];
      let pageState: string | undefined;
      do {
        const result = await this.send(cql, parameters, 5000, pageState);
        for (const row of result.rows ?? []) {
          rows.push(row.values().map(fromCassandra));
        }
        pageState = result.pageState ?? undefined;
      } while (pageState !== undefined && pageState !== '' && rows.length < METADATA_ROW_CAP);
      return rows;
    } finally {
      release();
    }
  }

  /** Read apart from `run`, which resets the flag, so the check is not folded away. */
  private wasCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * The driver cannot stop a request that is on its way: the page in flight finishes, its
   * rows are dropped, and no further page is asked for.
   */
  cancel(): Promise<void> {
    this.cancelled = true;
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.cancelled = true;
    await this.tail.catch(() => undefined);
    await this.client.shutdown().catch(() => undefined);
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    const release = await this.acquire();
    this.cancelled = false;
    try {
      const command = CONSISTENCY_COMMAND.exec(sql);
      if (command !== null) {
        yield* this.consistencyCommand(command[1] !== undefined, command[2]);
        return;
      }
      const { sql: statement, skip } = skipOf(sql.replace(/[\s;]+$/u, ''));
      const limit = options.rowLimit ?? Number.POSITIVE_INFINITY;
      let toSkip = skip;
      let sent = 0;
      let pageState: string | undefined;
      let announced = false;
      const warnings: string[] = [];
      do {
        const fetchSize = Number.isFinite(limit)
          ? Math.min(PAGE_SIZE, Math.max(1, limit + toSkip - sent))
          : PAGE_SIZE;
        const result = await this.send(statement, [], fetchSize, pageState);
        if (this.wasCancelled()) {
          throw new DbError('cancelled', msg('The statement was cancelled'));
        }
        warnings.push(...(result.info?.warnings ?? []));
        const columns = resultColumns(result);
        if (!announced && columns.length > 0) {
          announced = true;
          yield { kind: 'columns', columns };
        }
        let rows = (result.rows ?? []).map((row) => row.values().map(fromCassandra));
        if (toSkip > 0) {
          const dropped = Math.min(toSkip, rows.length);
          toSkip -= dropped;
          rows = rows.slice(dropped);
        }
        rows = rows.slice(0, Math.max(0, limit - sent));
        for (let start = 0; start < rows.length; start += ROW_BATCH_SIZE) {
          yield { kind: 'rows', rows: rows.slice(start, start + ROW_BATCH_SIZE) };
        }
        sent += rows.length;
        pageState = result.pageState ?? undefined;
        if (pageState === '') {
          pageState = undefined;
        }
      } while (pageState !== undefined && sent < limit);
      const notice = warnings.filter((warning) => warning !== '').join(' · ');
      yield { kind: 'done', ...(notice === '' ? {} : { notice }) };
    } finally {
      release();
    }
  }

  /** `CONSISTENCY [level]`, the cqlsh command: sets or shows the level of the next statements. */
  private async *consistencyCommand(
    serial: boolean,
    name: string | undefined,
  ): AsyncGenerator<ExecuteEvent> {
    if (serial) {
      throw new DbError(
        'unsupported',
        msg('SERIAL CONSISTENCY is not supported: lightweight transactions use their own level'),
      );
    }
    if (name !== undefined) {
      const level = consistencyByName(name);
      if (level === undefined) {
        throw new DbError('syntax', msg('Unknown consistency level "{0}"', name));
      }
      this.consistency = level;
    }
    await Promise.resolve();
    const current =
      this.consistency === undefined ? 'LOCAL_ONE' : consistencyName(this.consistency);
    yield { kind: 'done', notice: msg('Consistency level: {0}', current) };
  }

  /** One request to the server; every failure leaves as a DbError. */
  private async send(
    cql: string,
    parameters: readonly unknown[],
    fetchSize: number,
    pageState: string | undefined,
  ): Promise<CqlResult> {
    try {
      return await this.client.execute(cql, parameters, {
        fetchSize,
        prepare: false,
        ...(pageState === undefined ? {} : { pageState }),
        ...(this.consistency === undefined ? {} : { consistency: this.consistency }),
      });
    } catch (error) {
      throw toCassandraDbError(error);
    }
  }

  /** Waits for the statements before this one; the returned function lets the next go. */
  private async acquire(): Promise<() => void> {
    const before = this.tail;
    let release: () => void = () => undefined;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await before;
    return release;
  }
}
