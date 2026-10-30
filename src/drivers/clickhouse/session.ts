import { randomUUID } from 'node:crypto';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { StringDecoder } from 'node:string_decoder';
import {
  type ClickHouseClient,
  ClickHouseLogLevel,
  type ClickHouseSettings,
  createClient,
} from '@clickhouse/client';
import { DbError } from '../../core/errors';
import { leadingKeyword } from '../../core/sql/statement-kind';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import type { CellValue } from '../../shared/cell-value';
import { identityCheck, sniName, tlsFailure, type TlsMaterial, tlsMaterial } from '../common/tls';
import type { ExecuteEvent, ExecuteOptions, ResultColumn, Session } from '../driver';
import { toClickhouseDbError } from './errors';
import { ClickhouseMetadata } from './metadata';
import { toCellValue } from './values';
import { msg } from '../../core/user-message';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/** The format results are read in: names, then types, then one JSON array per row. */
export const RESULT_FORMAT = 'JSONCompactEachRowWithNamesAndTypes';

/** ClickHouse's HTTPS port, taken when TLS is on and no port is given. */
export const HTTPS_PORT = 8443;

/** A session lives this long without a request; the server's own limit is an hour. */
const SESSION_TIMEOUT_SECONDS = 3600;

/** Statements that answer with rows; everything else is run to its end and counted. */
const ROW_STATEMENTS = new Set(['SELECT', 'WITH', 'SHOW', 'DESCRIBE', 'DESC', 'EXISTS', 'EXPLAIN']);

/** Settings of every request: exact numbers, valid UTF-8, plain date-time text. */
export const OUTPUT_SETTINGS = {
  output_format_json_quote_64bit_integers: 1,
  output_format_json_quote_decimals: 1,
  output_format_json_quote_denormals: 1,
  output_format_json_validate_utf8: 1,
  // `12.50` in a Decimal(6, 2), as every other database prints it.
  output_format_decimal_trailing_zeros: 1,
  date_time_output_format: 'simple',
} as const satisfies ClickHouseSettings;

/**
 * What one statement sends besides the shared settings. A write is answered only once
 * it is done, so the summary has its real counts. `session_timeout` is a parameter of
 * the HTTP interface, not a setting, which the client's types do not know.
 */
export function requestSettings(rows: boolean, database: string | undefined): ClickHouseSettings {
  const settings: Record<string, string | number> = {
    session_timeout: SESSION_TIMEOUT_SECONDS,
    ...(rows ? { default_format: RESULT_FORMAT } : { wait_end_of_query: 1 }),
    ...databaseParam(database),
  };
  return settings;
}

/**
 * The database a request runs in, sent with each request rather than set on the client:
 * the server takes the first `database` parameter it sees, so a client-wide one would
 * make `USE` do nothing.
 */
function databaseParam(database: string | undefined): Record<string, string> {
  return database === undefined || database === '' ? {} : { database };
}

/** The database `USE x` switches to, unquoted. */
export function usedDatabase(sql: string): string | undefined {
  const match = /^\s*USE\s+(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|[A-Za-z_][\w$]*)\s*;?\s*$/iu.exec(
    sql,
  );
  const name = match?.[1];
  if (name === undefined) {
    return undefined;
  }
  return /^[`"]/u.test(name) ? name.slice(1, -1).replace(/\\(.)/gu, '$1') : name;
}

export function returnsRows(sql: string): boolean {
  return ROW_STATEMENTS.has(leadingKeyword(sql));
}

/** The HTTP agent: TLS checks as the connection asks, against the server's real name. */
export function agentFor(tls: TlsMaterial | undefined): HttpAgent | HttpsAgent {
  if (tls === undefined) {
    return new HttpAgent({ keepAlive: true });
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

export function clientUrl(config: ResolvedConnectionConfig, tls: TlsMaterial | undefined): string {
  const host = config.host ?? 'localhost';
  const port = config.port ?? (tls === undefined ? 8123 : HTTPS_PORT);
  // An IPv6 address needs brackets in a URL.
  const name = host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
  return `${tls === undefined ? 'http' : 'https'}://${name}:${port}`;
}

export async function openClickhouseSession(config: ResolvedConnectionConfig): Promise<Session> {
  const tls = await tlsMaterial(config);
  const client = createClient({
    url: clientUrl(config, tls),
    username: config.user ?? 'default',
    password: config.password ?? '',
    application: 'DataNest',
    // Failures reach the user as DbError; the client's own console log would only repeat them.
    log: { level: ClickHouseLogLevel.OFF },
    // Statements run as long as they need; QueryRunner cancels on its own timeout.
    request_timeout: 2_147_483_647,
    http_agent: agentFor(tls),
    set_basic_auth_header: true,
    clickhouse_settings: {
      ...OUTPUT_SETTINGS,
      // `2` refuses every write but still lets DataNest choose its output settings.
      ...(config.readOnly === true ? { readonly: '2' } : {}),
    },
  });
  const session = new ClickhouseSession(client, config.database);
  try {
    await session.check((config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000);
  } catch (error) {
    await client.close().catch(() => undefined);
    throw tlsFailure(error, tls?.serverName ?? '') ?? toClickhouseDbError(error);
  }
  return session;
}

interface Running {
  readonly queryId: string;
  readonly abort: AbortController;
  /** Set once the query is being killed, so a second stop waits for the same kill. */
  stopping?: Promise<void>;
}

class ClickhouseSession implements Session {
  readonly metadata: ClickhouseMetadata;
  private closed = false;
  /** HTTP sessions refuse a second request while one runs: each waits for the one before. */
  private chain: Promise<void> = Promise.resolve();
  private active: Running | undefined;
  private readonly sessionId = `datanest-${randomUUID()}`;

  /** The database requests run in; `USE` changes it. */
  private database: string | undefined;

  constructor(
    private readonly client: ClickHouseClient,
    database: string | undefined,
  ) {
    this.database = database === '' ? undefined : database;
    // Catalog reads need no session state, so they never wait behind a statement.
    this.metadata = new ClickhouseMetadata(async (sql, params) => await this.query(sql, params));
  }

  /** Signs in and asks something, within the connect timeout. */
  async check(timeoutMs: number): Promise<void> {
    const timer = AbortSignal.timeout(timeoutMs);
    const result = await this.client.exec({
      query: 'SELECT 1',
      abort_signal: timer,
      clickhouse_settings: {
        default_format: RESULT_FORMAT,
        ...databaseParam(this.database),
      },
    });
    for await (const _chunk of result.stream) {
      // The answer itself does not matter, only that it came.
    }
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  private lock(): Promise<() => void> {
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolve) => {
      release = resolve;
    });
    const previous = this.chain;
    this.chain = previous.then(() => next);
    return previous.then(() => release);
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    const release = await this.lock();
    const running: Running = { queryId: randomUUID(), abort: new AbortController() };
    this.active = running;
    const rowLimit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    let finished = false;
    try {
      const rows = returnsRows(sql);
      const result = await this.client.exec({
        query: sql,
        query_id: running.queryId,
        session_id: this.sessionId,
        abort_signal: running.abort.signal,
        clickhouse_settings: requestSettings(rows, this.database),
      });
      const format = headerOf(result.response_headers, 'x-clickhouse-format');
      if (!rows) {
        for await (const _chunk of result.stream) {
          // A statement without rows may still send a body (EXPLAIN-like output is rare).
        }
        const written = Number(result.summary?.written_rows ?? Number.NaN);
        this.database = usedDatabase(sql) ?? this.database;
        finished = true;
        yield leadingKeyword(sql) === 'INSERT' && Number.isFinite(written)
          ? { kind: 'done', affectedRows: written }
          : { kind: 'done' };
        return;
      }
      const reader =
        format === undefined || format === RESULT_FORMAT ? new JsonRows() : new TextRows(format);
      let sent = 0;
      let limitHit = false;
      for await (const chunk of result.stream as AsyncIterable<Buffer>) {
        const events = reader.push(chunk);
        for (const event of events) {
          if (event.kind === 'rows') {
            const room = rowLimit - sent;
            const rowsToSend = event.rows.slice(0, Math.max(0, room));
            sent += rowsToSend.length;
            if (rowsToSend.length > 0) {
              yield { kind: 'rows', rows: rowsToSend };
            }
            if (sent >= rowLimit) {
              limitHit = true;
              break;
            }
          } else {
            yield event;
          }
        }
        if (limitHit) {
          break;
        }
      }
      if (limitHit) {
        // Stop the server from producing rows nobody will see.
        await this.stop(running);
        finished = true;
      } else {
        for (const event of reader.end()) {
          yield event;
        }
      }
      finished = true;
      yield { kind: 'done' };
    } catch (error) {
      throw toClickhouseDbError(error, sql);
    } finally {
      if (!finished) {
        // The consumer stopped early or something failed: the server must let go of the
        // session before the next statement may use it.
        await this.stop(running);
      }
      if (this.active === running) {
        this.active = undefined;
      }
      release();
    }
  }

  /** Runs a catalog query with `{name:Type}` parameters, outside the session. */
  async query(sql: string, params: Record<string, string> = {}): Promise<unknown[][]> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    try {
      const result = await this.client.query({
        query: sql,
        format: 'JSONCompact',
        query_params: params,
        clickhouse_settings: databaseParam(this.database),
      });
      const body = await result.json<unknown[]>();
      return body.data;
    } catch (error) {
      throw toClickhouseDbError(error, sql);
    }
  }

  /**
   * Cancels the running statement: the request is dropped and the server is told to
   * kill the query by its id, from outside the session it holds.
   */
  async cancel(): Promise<void> {
    const running = this.active;
    if (this.closed || running === undefined) {
      return;
    }
    await this.stop(running);
  }

  /** Drops the request and waits until the server has killed the query (SYNC). */
  private async stop(running: Running): Promise<void> {
    if (running.stopping !== undefined) {
      await running.stopping;
      return;
    }
    running.abort.abort();
    running.stopping = this.kill(running.queryId);
    await running.stopping;
  }

  private async kill(queryId: string): Promise<void> {
    try {
      await this.client.command({
        query: 'KILL QUERY WHERE query_id = {id:String} SYNC',
        query_params: { id: queryId },
      });
    } catch (_error) {
      // The query may have finished on its own; dropping the request already freed us.
    }
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    await this.client.close().catch(() => undefined);
  }
}

function headerOf(headers: Record<string, unknown> | undefined, name: string): string | undefined {
  const value = headers?.[name];
  return typeof value === 'string' ? value : Array.isArray(value) ? String(value[0]) : undefined;
}

/** The error the server writes into a body that has already started. */
const EXCEPTION = /^Code: \d+\. DB::Exception: [\s\S]*\(version [^\n]*\)\s*$/u;

/**
 * An error after the first rows: JSON formats write it as a row of one string, others
 * as a plain line. The `(version …)` at its end tells it from a value that merely
 * starts like one.
 */
function exceptionText(line: string): string | undefined {
  if (EXCEPTION.test(line)) {
    return line;
  }
  if (!line.startsWith('["Code: ')) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(line) as unknown;
    const text: unknown = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : undefined;
    return typeof text === 'string' && EXCEPTION.test(text) ? text : undefined;
  } catch (_error) {
    return undefined;
  }
}

/** The server's error number and name, e.g. `Code: 395 … (FUNCTION_THROW_IF_VALUE_IS_NON_ZERO)`. */
function serverError(text: string): Error {
  const type = /\(([A-Z][A-Z0-9_]+)\)\s*(?:\(version [\s\S]*)?$/u.exec(text)?.[1];
  const code = /Code: (\d+)/u.exec(text)?.[1];
  return Object.assign(new Error(text.replace(/^Code: \d+\. DB::Exception: /u, '').trim()), {
    ...(type === undefined ? {} : { type }),
    ...(code === undefined ? {} : { code }),
  });
}

/** Splits a streamed body into lines, keeping characters whole across chunks. */
class Lines {
  private readonly decoder = new StringDecoder('utf8');
  private rest = '';

  push(chunk: Buffer): string[] {
    const text = this.rest + this.decoder.write(chunk);
    const lines = text.split('\n');
    this.rest = lines.pop() ?? '';
    return lines;
  }

  end(): string[] {
    const text = this.rest + this.decoder.end();
    this.rest = '';
    return text === '' ? [] : [text];
  }
}

type RowEvent = Extract<ExecuteEvent, { kind: 'columns' | 'rows' }>;

/** `JSONCompactEachRowWithNamesAndTypes`: a names line, a types line, then rows. */
export class JsonRows {
  private readonly lines = new Lines();
  private names: string[] | undefined;
  private types: string[] | undefined;

  push(chunk: Buffer): RowEvent[] {
    return this.read(this.lines.push(chunk));
  }

  end(): RowEvent[] {
    return this.read(this.lines.end());
  }

  private read(lines: readonly string[]): RowEvent[] {
    const events: RowEvent[] = [];
    let batch: CellValue[][] = [];
    for (const line of lines) {
      if (line.trim() === '') {
        continue;
      }
      const failure = exceptionText(line);
      if (failure !== undefined) {
        throw serverError(failure);
      }
      const values = JSON.parse(line) as unknown[];
      if (this.names === undefined) {
        this.names = values.map((name, index) =>
          typeof name === 'string' && name !== '' ? name : `column${index + 1}`,
        );
        continue;
      }
      if (this.types === undefined) {
        this.types = values.map((type) => String(type));
        const columns: ResultColumn[] = this.names.map((name, index) => ({
          name,
          dataType: this.types?.[index] ?? '',
        }));
        events.push({ kind: 'columns', columns });
        continue;
      }
      const types = this.types;
      batch.push(values.map((value, index) => toCellValue(value, types[index] ?? '')));
      if (batch.length >= ROW_BATCH_SIZE) {
        events.push({ kind: 'rows', rows: batch });
        batch = [];
      }
    }
    if (batch.length > 0) {
      events.push({ kind: 'rows', rows: batch });
    }
    return events;
  }
}

/** A format the user asked for (`FORMAT CSV`): its lines, as one text column. */
export class TextRows {
  private readonly lines = new Lines();
  private started = false;

  constructor(private readonly format: string) {}

  push(chunk: Buffer): RowEvent[] {
    return this.read(this.lines.push(chunk));
  }

  end(): RowEvent[] {
    return this.read(this.lines.end());
  }

  private read(lines: readonly string[]): RowEvent[] {
    const events: RowEvent[] = [];
    if (!this.started) {
      this.started = true;
      events.push({ kind: 'columns', columns: [{ name: this.format }] });
    }
    for (const line of lines) {
      const failure = exceptionText(line);
      if (failure !== undefined) {
        throw serverError(failure);
      }
    }
    if (lines.length > 0) {
      events.push({ kind: 'rows', rows: lines.map((line) => [line]) });
    }
    return events;
  }
}
