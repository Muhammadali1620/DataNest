import { DbError } from '../../core/errors';
import { isReadOnlyStatement } from '../../core/sql/read-only';
import { languageOf } from '../../core/sql/influx-language';
import { syntaxOf } from '../../core/sql/tokenizer';
import { msg } from '../../core/user-message';
import type { CellValue } from '../../shared/cell-value';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import { tlsFailure, tlsMaterial } from '../common/tls';
import type { ExecuteEvent, ExecuteOptions, ResultColumn, Session } from '../driver';
import { fromHttpStatus, toInfluxDbError } from './errors';
import { type FluxEvent, readFlux } from './flux-csv';
import { agentFor, type InfluxTarget, readText, send, targetUrl } from './http';
import { readInfluxql } from './influxql';
import { InfluxMetadata } from './metadata';

export { languageOf, type QueryLanguage } from '../../core/sql/influx-language';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/** What a session needs to know about the server it talks to. */
export interface InfluxSettings {
  readonly target: InfluxTarget;
  /** The organization (the user field of the connection). */
  readonly org: string;
  /** The bucket InfluxQL statements run on (its database mapping). */
  readonly database: string | undefined;
  readonly readOnly: boolean;
}

export async function openInfluxSession(config: ResolvedConnectionConfig): Promise<Session> {
  const tls = await tlsMaterial(config);
  const url = targetUrl(config.host, config.port ?? 8086, tls !== undefined);
  const token =
    config.password === undefined || config.password === '' ? undefined : config.password;
  const settings: InfluxSettings = {
    target: { url, ...(token === undefined ? {} : { token }), tls },
    org: (config.user ?? '').trim(),
    database: config.database === undefined || config.database === '' ? undefined : config.database,
    readOnly: config.readOnly === true,
  };
  const session = new InfluxSession(settings);
  try {
    await session.check((config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000);
  } catch (error) {
    await session.close();
    throw tlsFailure(error, tls?.serverName ?? '') ?? toInfluxDbError(error);
  }
  return session;
}

class InfluxSession implements Session {
  readonly metadata: InfluxMetadata;
  private readonly agent;
  private tail: Promise<void> = Promise.resolve();
  private current: AbortController | undefined;
  private closed = false;

  constructor(private readonly settings: InfluxSettings) {
    this.agent = agentFor(settings.target.url, settings.target.tls);
    this.metadata = new InfluxMetadata(this, settings, this.agent);
  }

  /** The first call: proves the address, the token and the organization. */
  async check(timeoutMs: number): Promise<void> {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await send(this.settings.target, this.agent, {
      method: 'GET',
      path: '/api/v2/buckets',
      query: { limit: '1', ...(this.settings.org === '' ? {} : { org: this.settings.org }) },
      signal,
    });
    const body = await readText(response.body);
    if (response.status >= 400) {
      throw fromHttpStatus(response.status, body);
    }
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /** The rows of a Flux query, for the metadata lookups. */
  async queryRows(flux: string): Promise<CellValue[][]> {
    const rows: CellValue[][] = [];
    for await (const event of this.run(flux, {})) {
      if (event.kind === 'rows') {
        rows.push(...event.rows.map((row) => [...row]));
      }
    }
    return rows;
  }

  /** The request is aborted; the server stops the query when its client goes away. */
  cancel(): Promise<void> {
    this.current?.abort();
    return Promise.resolve();
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.current?.abort();
    await this.tail.catch(() => undefined);
    this.agent.destroy();
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    if (this.settings.readOnly && !isReadOnlyStatement(sql, syntaxOf('influxdb'))) {
      throw new DbError(
        'permission-denied',
        msg('The connection is read-only: this statement could change data'),
      );
    }
    const release = await this.acquire();
    const controller = new AbortController();
    this.current = controller;
    try {
      const events = await this.open(sql, controller.signal);
      yield* this.rows(events, options, controller);
    } catch (error) {
      if (controller.signal.aborted && !this.isClosed()) {
        throw new DbError('cancelled', msg('The statement was cancelled'));
      }
      throw toInfluxDbError(error);
    } finally {
      this.current = undefined;
      release();
    }
  }

  /** Sends the statement in its language and returns the events of the answer. */
  private async open(sql: string, signal: AbortSignal): Promise<AsyncGenerator<FluxEvent>> {
    const { target, org, database } = this.settings;
    if (languageOf(sql) === 'flux') {
      const response = await send(target, this.agent, {
        method: 'POST',
        path: '/api/v2/query',
        query: org === '' ? {} : { org },
        body: JSON.stringify({
          query: sql,
          type: 'flux',
          dialect: {
            annotations: ['datatype', 'default'],
            header: true,
            delimiter: ',',
            commentPrefix: '#',
            dateTimeFormat: 'RFC3339',
          },
        }),
        accept: 'application/csv',
        signal,
      });
      if (response.status >= 400) {
        throw fromHttpStatus(response.status, await readText(response.body));
      }
      return readFlux(response.body);
    }
    const form = new URLSearchParams({ q: sql });
    const response = await send(target, this.agent, {
      method: 'POST',
      path: '/query',
      query: {
        chunked: 'true',
        chunk_size: '10000',
        ...(database === undefined ? {} : { db: database }),
      },
      body: form.toString(),
      contentType: 'application/x-www-form-urlencoded',
      signal,
    });
    if (response.status >= 400) {
      throw fromHttpStatus(response.status, await readText(response.body));
    }
    return readInfluxql(response.body);
  }

  /**
   * The events as result events. Tables that follow the first with other columns do not fit
   * one grid; they are left out and counted, and the notice says how to join them.
   */
  private async *rows(
    events: AsyncGenerator<FluxEvent>,
    options: ExecuteOptions,
    controller: AbortController,
  ): AsyncGenerator<ExecuteEvent> {
    const limit = options.rowLimit ?? Number.POSITIVE_INFINITY;
    let columns: readonly ResultColumn[] | undefined;
    let matching = false;
    let skipped = 0;
    let sent = 0;
    let batch: CellValue[][] = [];
    let enough = false;
    for await (const event of events) {
      if (event.kind === 'table') {
        if (columns === undefined) {
          columns = event.columns;
          matching = true;
          if (columns.length > 0) {
            yield { kind: 'columns', columns };
          }
        } else {
          matching = sameColumns(columns, event.columns);
          if (!matching) {
            skipped += 1;
          }
        }
        continue;
      }
      if (!matching) {
        continue;
      }
      batch.push([...event.cells]);
      sent += 1;
      if (batch.length >= ROW_BATCH_SIZE) {
        yield { kind: 'rows', rows: batch };
        batch = [];
      }
      if (sent >= limit) {
        // Enough: the rest of the answer is not read, and the server is told to stop.
        enough = true;
        break;
      }
    }
    if (enough) {
      // The stream is closed by now; aborting the request tells the server to stop.
      controller.abort();
    }
    if (batch.length > 0) {
      yield { kind: 'rows', rows: batch };
    }
    yield {
      kind: 'done',
      ...(skipped === 0
        ? {}
        : {
            notice: msg(
              '{0} more tables with other columns were left out: join them with group() or keep the same columns',
              String(skipped),
            ),
          }),
    };
  }

  private isClosed(): boolean {
    return this.closed;
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

function sameColumns(a: readonly ResultColumn[], b: readonly ResultColumn[]): boolean {
  return a.length === b.length && a.every((column, index) => column.name === b[index]?.name);
}
