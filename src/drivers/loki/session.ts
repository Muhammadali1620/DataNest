import { DbError } from '../../core/errors';
import { syntaxOf, tokenize } from '../../core/sql/tokenizer';
import { msg } from '../../core/user-message';
import type { CellValue } from '../../shared/cell-value';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import { tlsFailure, tlsMaterial } from '../common/tls';
import type { ExecuteEvent, ExecuteOptions, Session } from '../driver';
import { LokiApi } from './api';
import { type Directives, parseStatement } from './directives';
import { toLokiError } from './errors';
import { agentFor, type LokiTarget, targetUrl } from './http';
import { LokiMetadata } from './metadata';
import { translateTableQuery } from './table-query';
import { nowNs, resolveWindow } from './time';
import { readAnswer, sampleValue } from './values';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/** The most lines Loki hands over in one query unless its operator raised the limit. */
export const SERVER_LINE_LIMIT = 5000;

/** Lines read when neither the grid nor a `# limit:` says otherwise. */
export const DEFAULT_LIMIT = 1000;

/** How far back a query looks when nothing says: an hour. */
export const DEFAULT_RANGE = '1h';

/** What the session remembers between statements: the defaults a bare `# range:` sets. */
export interface SessionDefaults {
  range: string;
  direction: 'forward' | 'backward' | undefined;
  step: string | undefined;
  limit: number | undefined;
}

export interface LokiSettings {
  readonly target: LokiTarget;
}

export async function openLokiSession(config: ResolvedConnectionConfig): Promise<Session> {
  const tls = await tlsMaterial(config);
  const url = targetUrl(config.host, config.port ?? 3100, tls !== undefined);
  const settings: LokiSettings = {
    target: {
      url,
      ...(config.user === undefined || config.user.trim() === '' ? {} : { user: config.user }),
      ...(config.password === undefined || config.password === ''
        ? {}
        : { secret: config.password }),
      ...(config.database === undefined || config.database.trim() === ''
        ? {}
        : { tenant: config.database.trim() }),
      tls,
    },
  };
  const session = new LokiSession(settings);
  try {
    await session.check((config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000);
  } catch (error) {
    await session.close();
    throw tlsFailure(error, tls?.serverName ?? '') ?? toLokiError(error);
  }
  return session;
}

/** The query text without its comments: the directives are ours, not the server's. */
function withoutComments(sql: string): string {
  const syntax = syntaxOf('loki');
  let text = '';
  for (const token of tokenize(sql, syntax)) {
    text += token.kind === 'comment' ? ' ' : sql.slice(token.start, token.end);
  }
  return text.trim();
}

class LokiSession implements Session {
  readonly metadata: LokiMetadata;
  private readonly api: LokiApi;
  private readonly agent;
  private tail: Promise<void> = Promise.resolve();
  private current: AbortController | undefined;
  private closed = false;
  private readonly defaults: SessionDefaults = {
    range: DEFAULT_RANGE,
    direction: undefined,
    step: undefined,
    limit: undefined,
  };

  constructor(settings: LokiSettings) {
    this.agent = agentFor(settings.target.url, settings.target.tls);
    this.api = new LokiApi(settings.target, this.agent);
    this.metadata = new LokiMetadata(this.api, () => this.defaults.range);
  }

  /** The first call: proves the address, the tenant and the credentials. */
  async check(timeoutMs: number): Promise<void> {
    const end = nowNs(new Date());
    await this.api.text(
      '/loki/api/v1/labels',
      { start: String(end - 3_600_000_000_000n), end: String(end) },
      AbortSignal.timeout(timeoutMs),
    );
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /** The request is aborted; Loki stops a query whose client is gone. */
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
    const release = await this.acquire();
    const controller = new AbortController();
    this.current = controller;
    try {
      yield* this.statement(sql, options, controller.signal);
    } catch (error) {
      if (controller.signal.aborted && !this.isClosed()) {
        throw new DbError('cancelled', msg('The statement was cancelled'));
      }
      throw toLokiError(error);
    } finally {
      this.current = undefined;
      release();
    }
  }

  private async *statement(
    sql: string,
    options: ExecuteOptions,
    signal: AbortSignal,
  ): AsyncGenerator<ExecuteEvent> {
    const parsed = parseStatement(sql);
    if (!parsed.hasQuery) {
      yield { kind: 'done', notice: this.setDefaults(parsed.directives) };
      return;
    }
    const table = translateTableQuery(sql);
    const directives = parsed.directives;
    const range = directives.range ?? this.defaults.range;
    const window = resolveWindow({ ...directives, range }, this.defaults.range);
    if (table?.kind === 'count') {
      yield* this.count(table.selector, window, signal);
      return;
    }
    const lineDirection =
      table?.direction ?? directives.direction ?? this.defaults.direction ?? 'backward';
    const sampleDirection = directives.direction ?? this.defaults.direction ?? 'forward';
    const offset = table?.offset ?? 0;
    const asked = table?.limit ?? directives.limit ?? this.defaults.limit ?? DEFAULT_LIMIT;
    const wanted = Math.min(options.rowLimit ?? Number.POSITIVE_INFINITY, asked);
    // One line more than wanted, so that the answer tells whether the window held more.
    const requested = Math.min(wanted + offset + 1, SERVER_LINE_LIMIT);
    const step = directives.step ?? this.defaults.step;
    const body = await this.api.text(
      '/loki/api/v1/query_range',
      {
        query: table?.selector ?? withoutComments(sql),
        start: window.startNs.toString(),
        end: window.endNs.toString(),
        limit: String(requested),
        direction: lineDirection,
        ...(step === undefined ? {} : { step }),
      },
      signal,
    );
    const answer = readAnswer(
      body,
      { lines: lineDirection, samples: sampleDirection },
      wanted,
      offset,
    );
    yield { kind: 'columns', columns: answer.columns };
    for (let index = 0; index < answer.rows.length; index += ROW_BATCH_SIZE) {
      yield { kind: 'rows', rows: answer.rows.slice(index, index + ROW_BATCH_SIZE) };
    }
    const capped =
      wanted + offset > SERVER_LINE_LIMIT && answer.rows.length + offset >= SERVER_LINE_LIMIT;
    yield {
      kind: 'done',
      ...(capped
        ? {
            notice: msg(
              'Loki returns at most {0} lines for one query: narrow the range or the selector for the rest',
              String(SERVER_LINE_LIMIT),
            ),
          }
        : answer.more && answer.kind === 'streams' && wanted === asked
          ? {
              notice: msg(
                'There are more lines in this window than were read: raise "# limit:" or narrow the query',
              ),
            }
          : {}),
    };
  }

  /** How many lines a label's streams hold in the window: one metric query. */
  private async *count(
    selector: string,
    window: { readonly startNs: bigint; readonly endNs: bigint },
    signal: AbortSignal,
  ): AsyncGenerator<ExecuteEvent> {
    const seconds = Math.max(
      1,
      Math.ceil(Number((window.endNs - window.startNs) / 1_000_000_000n)),
    );
    const body = await this.api.text(
      '/loki/api/v1/query',
      {
        query: `sum(count_over_time(${selector}[${seconds}s]))`,
        time: window.endNs.toString(),
      },
      signal,
    );
    const document = JSON.parse(body) as {
      data?: { result?: { value?: [unknown, unknown] }[] };
    };
    const value = document.data?.result?.[0]?.value?.[1];
    const total: CellValue = value === undefined ? 0 : sampleValue(value);
    yield { kind: 'columns', columns: [{ name: 'count', dataType: 'bigint' }] };
    yield { kind: 'rows', rows: [[total]] };
    yield { kind: 'done' };
  }

  /** A statement of directives only: what later statements of the session start from. */
  private setDefaults(directives: Directives): string {
    const told: string[] = [];
    if (directives.range !== undefined) {
      this.defaults.range = directives.range;
      told.push(`range ${directives.range}`);
    }
    if (directives.direction !== undefined) {
      this.defaults.direction = directives.direction;
      told.push(`direction ${directives.direction}`);
    }
    if (directives.step !== undefined) {
      this.defaults.step = directives.step;
      told.push(`step ${directives.step}`);
    }
    if (directives.limit !== undefined) {
      this.defaults.limit = directives.limit;
      told.push(`limit ${directives.limit}`);
    }
    return told.length === 0
      ? msg('Nothing to run: write a LogQL query below the comments')
      : msg('Defaults of this session: {0}', told.join(', '));
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
