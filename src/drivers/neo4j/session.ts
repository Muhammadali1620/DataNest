import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import type { CellValue } from '../../shared/cell-value';
import { tlsFailure, tlsMaterial } from '../common/tls';
import type { ExecuteEvent, ExecuteOptions, ResultColumn, Session } from '../driver';
import { toNeo4jDbError } from './errors';
import { Neo4jMetadata } from './metadata';
import {
  agentFor,
  basicAuthorization,
  postQuery,
  type QueryAnswer,
  queryUrl,
  readAnswer,
  requestBody,
  targetUrl,
  type TypedValue,
} from './query-api';
import {
  NODE_PARTS,
  RELATIONSHIP_PARTS,
  translateTableQuery,
  type TableQuery,
} from './table-query';
import { fromTyped, typeName } from './values';

/** Rows travel from the driver in batches of this size. */
export const ROW_BATCH_SIZE = 200;

/** The database a connection opens when it names none. */
export const DEFAULT_DATABASE = 'neo4j';

interface Endpoint {
  readonly base: URL;
  readonly authorization: string | undefined;
  readonly agent: ReturnType<typeof agentFor>;
}

export async function openNeo4jSession(config: ResolvedConnectionConfig): Promise<Session> {
  const tls = await tlsMaterial(config);
  const base = targetUrl(config.host, config.port, tls !== undefined);
  const endpoint: Endpoint = {
    base,
    authorization: basicAuthorization(config.user, config.password),
    agent: agentFor(base, tls),
  };
  const named = (config.database ?? '').trim();
  const database = named === '' ? DEFAULT_DATABASE : named;
  const session = new Neo4jSession(
    endpoint,
    database,
    config.readOnly === true,
    (config.options?.queryTimeout ?? 0) * 1000,
  );
  try {
    await session.check((config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000);
  } catch (error) {
    await session.close();
    throw tlsFailure(error, tls?.serverName ?? '') ?? toNeo4jDbError(error);
  }
  return session;
}

/** The counters a statement reports, as a short line: "Nodes created: 2, Properties set: 6". */
export function countersNotice(counters: Readonly<Record<string, unknown>> | undefined): string {
  const count = (name: string): number => {
    const value = counters?.[name];
    return typeof value === 'number' ? value : 0;
  };
  const parts: string[] = [];
  const add = (name: string, make: (n: string) => string): void => {
    const value = count(name);
    if (value > 0) {
      parts.push(make(String(value)));
    }
  };
  add('nodesCreated', (n) => msg('Nodes created: {0}', n));
  add('nodesDeleted', (n) => msg('Nodes deleted: {0}', n));
  add('relationshipsCreated', (n) => msg('Relationships created: {0}', n));
  add('relationshipsDeleted', (n) => msg('Relationships deleted: {0}', n));
  add('propertiesSet', (n) => msg('Properties set: {0}', n));
  add('labelsAdded', (n) => msg('Labels added: {0}', n));
  add('labelsRemoved', (n) => msg('Labels removed: {0}', n));
  add('indexesAdded', (n) => msg('Indexes added: {0}', n));
  add('indexesRemoved', (n) => msg('Indexes removed: {0}', n));
  add('constraintsAdded', (n) => msg('Constraints added: {0}', n));
  add('constraintsRemoved', (n) => msg('Constraints removed: {0}', n));
  return parts.join(', ');
}

/** Entities created or deleted: what "rows affected" means for a graph. */
function affectedOf(counters: Readonly<Record<string, unknown>> | undefined): number | undefined {
  let total = 0;
  for (const name of [
    'nodesCreated',
    'nodesDeleted',
    'relationshipsCreated',
    'relationshipsDeleted',
  ]) {
    const value = counters?.[name];
    total += typeof value === 'number' ? value : 0;
  }
  return total > 0 ? total : undefined;
}

function firstType(rows: readonly (readonly TypedValue[])[], column: number): string | undefined {
  for (const row of rows) {
    const name = typeName(row[column]);
    if (name !== undefined) {
      return name;
    }
  }
  return undefined;
}

/** What a statement came back with, in the shape the grid wants. */
interface Shaped {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly (readonly CellValue[])[];
}

/** Rows of a plain Cypher statement: a column per returned name. */
function shapePlain(answer: QueryAnswer): Shaped {
  const columns = answer.fields.map((name, index) => {
    const type = firstType(answer.values, index);
    return type === undefined ? { name } : { name, dataType: type };
  });
  return {
    columns,
    rows: answer.values.map((row) => answer.fields.map((_name, index) => fromTyped(row[index]))),
  };
}

function propertiesOf(value: TypedValue | undefined): Record<string, TypedValue> {
  const map = value?._value;
  return typeof map === 'object' && map !== null && !Array.isArray(map)
    ? (map as Record<string, TypedValue>)
    : {};
}

/** Rows of a label or relationship type: the parts of the entity, then its property keys. */
function shapeEntities(answer: QueryAnswer, query: TableQuery): Shaped {
  const parts: readonly string[] = query.kind === 'nodes' ? NODE_PARTS : RELATIONSHIP_PARTS;
  const partIndex = (name: string): number => answer.fields.indexOf(name);
  const propertiesIndex = answer.fields.indexOf('_properties');
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const row of answer.values) {
    for (const key of Object.keys(propertiesOf(row[propertiesIndex]))) {
      if (!seen.has(key)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  // The server lists a node's properties in the order it stored them: sorted, a label's
  // columns stay where the tree shows them whatever page is open.
  keys.sort((a, b) => a.localeCompare(b));
  const names =
    query.columns === '*' || query.columns === 'count' ? [...parts, ...keys] : [...query.columns];
  const cell = (row: readonly TypedValue[], name: string): TypedValue | undefined => {
    const index = parts.includes(name) ? partIndex(name) : -1;
    return index >= 0 ? row[index] : propertiesOf(row[propertiesIndex])[name];
  };
  const columns = names.map((name) => {
    const type = typeName(
      answer.values.map((row) => cell(row, name)).find((value) => typeName(value) !== undefined),
    );
    return type === undefined ? { name } : { name, dataType: type };
  });
  return {
    columns,
    rows: answer.values.map((row) => names.map((name) => fromTyped(cell(row, name)))),
  };
}

class Neo4jSession implements Session {
  readonly metadata: Neo4jMetadata;
  /** Requests are sent one at a time, as every other session does. */
  private tail: Promise<void> = Promise.resolve();
  private current: AbortController | undefined;
  private closed = false;

  constructor(
    private readonly endpoint: Endpoint,
    private readonly database: string,
    private readonly readOnly: boolean,
    private readonly queryTimeoutMs: number,
  ) {
    this.metadata = new Neo4jMetadata(this);
  }

  /** The first request: proves the address, the sign-in and the database. */
  async check(timeoutMs: number): Promise<void> {
    const release = await this.acquire();
    try {
      await this.post('RETURN 1', undefined, AbortSignal.timeout(timeoutMs));
    } finally {
      release();
    }
  }

  execute(sql: string, options: ExecuteOptions = {}): AsyncIterable<ExecuteEvent> {
    return this.run(sql, options);
  }

  /** Rows of a parameterized read; used by metadata lookups. */
  async queryRows(
    cypher: string,
    parameters?: Readonly<Record<string, unknown>>,
  ): Promise<CellValue[][]> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    const release = await this.acquire();
    try {
      const answer = await this.post(cypher, parameters, undefined, true);
      return answer.values.map((row) => answer.fields.map((_name, index) => fromTyped(row[index])));
    } finally {
      release();
    }
  }

  /** Abandons the statement in flight: its request is aborted, and the server stops it. */
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
    this.endpoint.agent.destroy();
  }

  private async *run(sql: string, options: ExecuteOptions): AsyncGenerator<ExecuteEvent> {
    if (this.closed) {
      throw new DbError('internal', msg('The session is closed'));
    }
    const release = await this.acquire();
    try {
      const table = translateTableQuery(sql);
      const statement = table?.cypher ?? sql.replace(/[\s;]+$/u, '');
      const answer = await this.post(
        statement,
        undefined,
        this.queryTimeoutMs > 0 ? AbortSignal.timeout(this.queryTimeoutMs) : undefined,
      );
      const notice = [countersNotice(answer.counters), ...answer.notifications]
        .filter((part) => part !== '')
        .join(' · ');
      const affected = affectedOf(answer.counters);
      const done: ExecuteEvent = {
        kind: 'done',
        ...(affected === undefined ? {} : { affectedRows: affected }),
        ...(notice === '' ? {} : { notice }),
      };
      if (table === undefined && answer.fields.length === 0) {
        yield done;
        return;
      }
      const shaped =
        table === undefined || table.columns === 'count'
          ? shapePlain(answer)
          : shapeEntities(answer, table);
      yield { kind: 'columns', columns: shaped.columns };
      const limit = options.rowLimit ?? Number.POSITIVE_INFINITY;
      const total = Math.min(shaped.rows.length, limit);
      for (let start = 0; start < total; start += ROW_BATCH_SIZE) {
        yield {
          kind: 'rows',
          rows: shaped.rows.slice(start, Math.min(start + ROW_BATCH_SIZE, total)),
        };
      }
      yield done;
    } finally {
      release();
    }
  }

  /** Sends one statement. `fixedSignal` is a timeout; a cancel aborts the controller. */
  private async post(
    statement: string,
    parameters: Readonly<Record<string, unknown>> | undefined,
    fixedSignal: AbortSignal | undefined,
    metadata = false,
  ): Promise<QueryAnswer> {
    const controller = new AbortController();
    this.current = controller;
    const signal =
      fixedSignal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, fixedSignal]);
    try {
      const answer = await postQuery(
        queryUrl(this.endpoint.base, this.database),
        requestBody(statement, parameters, this.readOnly || metadata),
        { authorization: this.endpoint.authorization, agent: this.endpoint.agent, signal },
      );
      return readAnswer(answer);
    } catch (error) {
      throw toNeo4jDbError(error);
    } finally {
      this.current = undefined;
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
