import { afterEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { ExecuteEvent, Session } from '../../../../src/drivers/driver';
import { ROW_BATCH_SIZE, openLibsqlSession } from '../../../../src/drivers/libsql/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeHrana, type FakeResult } from '../../../helpers/fake-hrana';

const int = (value: number) => ({ type: 'integer', value: String(value) });
const text = (value: string) => ({ type: 'text', value });

async function collect(events: AsyncIterable<ExecuteEvent>): Promise<ExecuteEvent[]> {
  const all: ExecuteEvent[] = [];
  for await (const event of events) {
    all.push(event);
  }
  return all;
}

describe('libsql session', () => {
  let fake: FakeHrana;
  let port: number;
  const sessions: Session[] = [];

  async function serve(options: ConstructorParameters<typeof FakeHrana>[0] = {}): Promise<void> {
    fake = new FakeHrana(options);
    port = await fake.start();
  }

  function config(extra: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
    return {
      id: 'c',
      name: 'libsql',
      driver: 'libsql',
      host: '127.0.0.1',
      port,
      ...extra,
    };
  }

  async function open(extra: Partial<ResolvedConnectionConfig> = {}): Promise<Session> {
    const session = await openLibsqlSession(config(extra));
    sessions.push(session);
    return session;
  }

  afterEach(async () => {
    await Promise.all(sessions.splice(0).map((session) => session.close()));
    await fake.stop();
  });

  describe('opening', () => {
    it('proves the server answers with a first request', async () => {
      await serve();
      await open();
      expect(fake.statements).toEqual(['SELECT 1']);
    });

    it('sends the password as the auth token', async () => {
      await serve({ token: 'tok' });
      await open({ password: 'tok' });
      expect(fake.records[0]?.authorization).toBe('Bearer tok');
    });

    it('sends no authorization without a token', async () => {
      await serve();
      await open({ password: '' });
      expect(fake.records[0]?.authorization).toBeUndefined();
    });

    it('fails a wrong token as a failed sign-in', async () => {
      await serve({ token: 'tok' });
      await expect(open({ password: 'nope' })).rejects.toMatchObject({ code: 'auth-failed' });
      await expect(open()).rejects.toMatchObject({ code: 'auth-failed' });
    });

    it('fails an unreachable server as a failed connection', async () => {
      await serve();
      await expect(open({ port: 1 })).rejects.toMatchObject({ code: 'connection-failed' });
    });

    it('fails a server that is too slow within the connect timeout', async () => {
      await serve();
      fake.delayMs = 2500;
      await expect(open({ options: { connectTimeout: 1 } })).rejects.toMatchObject({
        code: 'timeout',
      });
    });

    it('fails when the first statement is refused', async () => {
      await serve({ handler: () => ({ error: { message: 'closed for maintenance' } }) });
      await expect(open()).rejects.toMatchObject({ message: 'closed for maintenance' });
    });

    it('opens a read-only connection to a server that does not know the pragma', async () => {
      await serve({
        handler: (statement) =>
          statement.sql.startsWith('PRAGMA')
            ? { error: { message: 'unsupported statement', code: 'SQL_PARSE_ERROR' } }
            : {},
      });
      const session = await open({ readOnly: true });
      expect(await collect(session.execute('SELECT 1'))).toBeDefined();
      expect(fake.statements.filter((sql) => sql.startsWith('PRAGMA'))).toHaveLength(1);
    });

    it('makes a read-only connection read-only on the server', async () => {
      await serve();
      await open({ readOnly: true });
      expect(fake.statements.slice(0, 2)).toEqual(['PRAGMA query_only = 1', 'SELECT 1']);
    });

    it('reaches a TLS server through the host field URL', async () => {
      await serve();
      const session = await open({ host: `http://127.0.0.1:${port}`, port: undefined });
      expect(session).toBeDefined();
    });
  });

  describe('statements', () => {
    it('streams the columns, the rows and a done', async () => {
      await serve({
        handler: () => ({
          cols: [
            { name: 'id', decltype: 'INTEGER' },
            { name: 'name', decltype: 'TEXT' },
            { name: null, decltype: null },
          ],
          rows: [
            [int(1), text('a'), { type: 'null' }],
            [int(2), text('b'), { type: 'float', value: 1.5 }],
          ],
        }),
      });
      const session = await open();
      const events = await collect(session.execute('SELECT * FROM t'));
      expect(events).toEqual([
        {
          kind: 'columns',
          columns: [
            { name: 'id', dataType: 'integer' },
            { name: 'name', dataType: 'text' },
            { name: 'column3' },
          ],
        },
        {
          kind: 'rows',
          rows: [
            [1, 'a', null],
            [2, 'b', 1.5],
          ],
        },
        { kind: 'done' },
      ]);
    });

    it('sends the statement as written, asking for rows', async () => {
      await serve({ handler: () => ({}) });
      const session = await open();
      await collect(session.execute("SELECT 'x'; "));
      const request = fake.records.at(-1)?.requests[0];
      expect(request?.stmt).toMatchObject({ sql: "SELECT 'x'; ", want_rows: true });
      expect(request?.stmt?.args).toEqual([]);
    });

    it('reports the rows a statement without a result changed', async () => {
      await serve({ handler: () => ({ affected: 3 }) });
      const session = await open();
      expect(await collect(session.execute('DELETE FROM t'))).toEqual([
        { kind: 'done', affectedRows: 3 },
      ]);
    });

    it('sends rows in batches', async () => {
      const rows = Array.from({ length: ROW_BATCH_SIZE * 2 + 5 }, (_, i) => [int(i)]);
      await serve({ handler: () => ({ cols: [{ name: 'n', decltype: null }], rows }) });
      const session = await open();
      const events = await collect(session.execute('SELECT n FROM t'));
      const batches = events.flatMap((e) => (e.kind === 'rows' ? [e] : []));
      expect(batches.map((e) => e.rows.length)).toEqual([ROW_BATCH_SIZE, ROW_BATCH_SIZE, 5]);
      expect(events.at(-1)).toEqual({ kind: 'done' });
    });

    it('stops at the row limit', async () => {
      const rows = Array.from({ length: 1000 }, (_, i) => [int(i)]);
      await serve({ handler: () => ({ cols: [{ name: 'n', decltype: null }], rows }) });
      const session = await open();
      const events = await collect(session.execute('SELECT n FROM t', { rowLimit: 250 }));
      const total = events.reduce((sum, e) => sum + (e.kind === 'rows' ? e.rows.length : 0), 0);
      expect(total).toBe(250);
      expect(events.at(-1)).toEqual({ kind: 'done' });
    });

    it('answers a statement with columns but no rows', async () => {
      await serve({ handler: () => ({ cols: [{ name: 'n', decltype: null }], rows: [] }) });
      const session = await open();
      expect(await collect(session.execute('SELECT n FROM t WHERE 0'))).toEqual([
        { kind: 'columns', columns: [{ name: 'n' }] },
        { kind: 'done' },
      ]);
    });

    it('keeps exact integers and bytes', async () => {
      await serve({
        handler: () => ({
          cols: [
            { name: 'big', decltype: null },
            { name: 'blob', decltype: null },
          ],
          rows: [[int(0), { type: 'blob', base64: 'AQID' }]],
        }),
      });
      const session = await open();
      const events = await collect(session.execute('SELECT 1'));
      const rows = events.find((e) => e.kind === 'rows');
      expect(rows?.kind === 'rows' ? rows.rows[0]?.[1] : undefined).toMatchObject({
        kind: 'binary',
        size: 3,
      });
    });

    it('raises the error of the server with its meaning', async () => {
      await serve({
        handler: (statement) =>
          statement.sql.includes('bad')
            ? { error: { message: 'UNIQUE constraint failed: t.id', code: 'SQLITE_CONSTRAINT' } }
            : {},
      });
      const session = await open();
      const error = await collect(session.execute('INSERT bad')).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toMatchObject({
        code: 'constraint',
        message: 'UNIQUE constraint failed: t.id',
      });
      // The session lives on.
      expect(await collect(session.execute('SELECT 2'))).toEqual([
        { kind: 'done', affectedRows: 0 },
      ]);
    });

    it('answers in the form it knows when the server breaks the protocol', async () => {
      await serve();
      const session = await open();
      fake.failNext = { status: 200, body: JSON.stringify({ baton: null, results: [] }) };
      await expect(collect(session.execute('SELECT 2'))).rejects.toMatchObject({
        code: 'internal',
      });
      fake.failNext = {
        status: 200,
        body: JSON.stringify({
          baton: null,
          results: [{ type: 'ok', response: { type: 'execute', result: 5 } }],
        }),
      };
      await expect(collect(session.execute('SELECT 2'))).rejects.toMatchObject({
        code: 'internal',
      });
    });

    it('refuses a statement on a closed session', async () => {
      await serve();
      const session = await open();
      await session.close();
      await expect(collect(session.execute('SELECT 1'))).rejects.toMatchObject({
        code: 'internal',
      });
    });

    it('runs statements one at a time, in the order asked', async () => {
      const order: string[] = [];
      await serve({
        handler: async (statement) => {
          order.push(`start ${statement.sql}`);
          await new Promise((resolve) => setTimeout(resolve, 30));
          order.push(`end ${statement.sql}`);
          return {};
        },
      });
      const session = await open();
      order.length = 0;
      await Promise.all([
        collect(session.execute('A')),
        collect(session.execute('B')),
        collect(session.execute('C')),
      ]);
      expect(order).toEqual(['start A', 'end A', 'start B', 'end B', 'start C', 'end C']);
    });

    it('lets the next statement go when the reader gives up', async () => {
      const rows = Array.from({ length: 600 }, (_, i) => [int(i)]);
      await serve({
        handler: (statement) =>
          statement.sql === 'many' ? { cols: [{ name: 'n', decltype: null }], rows } : {},
      });
      const session = await open();
      for await (const event of session.execute('many')) {
        if (event.kind === 'rows') {
          break;
        }
      }
      await expect(collect(session.execute('next'))).resolves.toEqual([
        { kind: 'done', affectedRows: 0 },
      ]);
    });
  });

  describe('parameters', () => {
    it('binds them as values, never in the text', async () => {
      await serve({ handler: () => ({}) });
      const session = (await open()) as Session & {
        queryRows(sql: string, params: readonly (string | number | null)[]): Promise<unknown>;
      };
      await session.queryRows('SELECT ?, ?, ?, ?', ["x'; DROP TABLE t; --", 7, 1.5, null]);
      const stmt = fake.records.at(-1)?.requests[0]?.stmt;
      expect(stmt?.sql).toBe('SELECT ?, ?, ?, ?');
      expect(stmt?.args).toEqual([
        { type: 'text', value: "x'; DROP TABLE t; --" },
        { type: 'integer', value: '7' },
        { type: 'float', value: 1.5 },
        { type: 'null' },
      ]);
    });

    it('collects the rows of a lookup', async () => {
      await serve({
        handler: () => ({ cols: [{ name: 'n', decltype: null }], rows: [[int(1)], [int(2)]] }),
      });
      const session = (await open()) as Session & {
        queryRows(sql: string, params: readonly never[]): Promise<unknown[][]>;
      };
      expect(await session.queryRows('SELECT n', [])).toEqual([[1], [2]]);
    });
  });

  describe('transactions', () => {
    it('follows what the server says after each statement', async () => {
      await serve();
      const session = await open();
      expect(session.transactionState?.()).toBe('idle');
      await collect(session.execute('BEGIN'));
      expect(session.transactionState?.()).toBe('open');
      await collect(session.execute('INSERT INTO t VALUES (1)'));
      expect(session.transactionState?.()).toBe('open');
      await collect(session.execute('ROLLBACK'));
      expect(session.transactionState?.()).toBe('idle');
      await collect(session.execute('BEGIN'));
      await collect(session.execute('COMMIT'));
      expect(session.transactionState?.()).toBe('idle');
    });

    it('keeps the transaction on one stream', async () => {
      await serve();
      const session = await open();
      await collect(session.execute('BEGIN'));
      await collect(session.execute('SELECT 2'));
      expect(new Set([...fake.streams.values()]).size).toBe(1);
    });

    it('still sees the transaction open after a failed statement', async () => {
      await serve({
        handler: (statement) =>
          statement.sql === 'FAIL' ? { error: { message: 'oops', code: 'SQLITE_ERROR' } } : {},
      });
      const session = await open();
      await collect(session.execute('BEGIN'));
      await expect(collect(session.execute('FAIL'))).rejects.toBeInstanceOf(DbError);
      expect(session.transactionState?.()).toBe('open');
    });

    it('cannot tell on a server without Hrana 3', async () => {
      await serve({ v3: false });
      const session = await open();
      expect(session.transactionState?.()).toBeUndefined();
      await collect(session.execute('BEGIN'));
      expect(session.transactionState?.()).toBeUndefined();
    });
  });

  describe('a stream the server forgot', () => {
    it('starts a new one when no transaction was open', async () => {
      await serve();
      const session = await open();
      await collect(session.execute('SELECT 2'));
      fake.expireAll();
      await expect(collect(session.execute('SELECT 3'))).resolves.toEqual([
        { kind: 'done', affectedRows: 0 },
      ]);
      expect(fake.statements.at(-1)).toBe('SELECT 3');
    });

    it('says an open transaction is lost, and carries on afterwards', async () => {
      await serve();
      const session = await open();
      await collect(session.execute('BEGIN'));
      fake.expireAll();
      await expect(collect(session.execute('INSERT INTO t VALUES (1)'))).rejects.toMatchObject({
        code: 'connection-failed',
      });
      expect(session.transactionState?.()).toBe('idle');
      await expect(collect(session.execute('SELECT 3'))).resolves.toBeDefined();
    });

    it('turns query_only on again for the new stream of a read-only connection', async () => {
      await serve();
      const session = await open({ readOnly: true });
      fake.expireAll();
      await collect(session.execute('SELECT 3'));
      expect(fake.statements.filter((sql) => sql.startsWith('PRAGMA'))).toHaveLength(2);
    });
  });

  describe('cancelling', () => {
    it('aborts the statement that runs and says it was cancelled', async () => {
      await serve();
      const session = await open();
      fake.delayMs = 400;
      const running = collect(session.execute('SELECT slow')).catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.cancel();
      expect(await running).toMatchObject({ code: 'cancelled' });
    });

    it('lets the session work again, on a new stream', async () => {
      await serve();
      const session = await open();
      await collect(session.execute('BEGIN'));
      fake.delayMs = 300;
      const running = collect(session.execute('SELECT slow')).catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 40));
      await session.cancel();
      await running;
      fake.delayMs = 0;
      // The transaction went with the stream.
      expect(session.transactionState?.()).toBe('idle');
      await expect(collect(session.execute('SELECT 4'))).resolves.toBeDefined();
      expect(fake.records.at(-1)?.baton).toBeNull();
    });

    it('does nothing when no statement runs', async () => {
      await serve();
      const session = await open();
      await expect(session.cancel()).resolves.toBeUndefined();
      await expect(collect(session.execute('SELECT 2'))).resolves.toBeDefined();
    });

    it('lets the statements that wait go on', async () => {
      await serve();
      const session = await open();
      fake.delayMs = 300;
      const first = collect(session.execute('SELECT first')).catch((e: unknown) => e);
      const second = collect(session.execute('SELECT second'));
      await new Promise((resolve) => setTimeout(resolve, 40));
      fake.delayMs = 0;
      await session.cancel();
      expect(await first).toMatchObject({ code: 'cancelled' });
      await expect(second).resolves.toBeDefined();
    });
  });

  describe('closing', () => {
    it('closes the stream on the server', async () => {
      await serve();
      const session = await open();
      await session.close();
      expect(fake.records.at(-1)?.requests.map((r) => r.type)).toEqual(['close']);
    });

    it('closes twice without harm', async () => {
      await serve();
      const session = await open();
      await session.close();
      await expect(session.close()).resolves.toBeUndefined();
    });

    it('stops a running statement', async () => {
      await serve();
      const session = await open();
      fake.delayMs = 400;
      const running = collect(session.execute('SELECT slow')).catch((e: unknown) => e);
      await new Promise((resolve) => setTimeout(resolve, 40));
      await session.close();
      expect(await running).toBeInstanceOf(DbError);
    });
  });

  describe('structure', () => {
    it('reads tables and columns through the SQLite catalog', async () => {
      await serve({
        handler: (statement) => {
          if (statement.sql.includes('sqlite_master')) {
            return {
              cols: [
                { name: 'name', decltype: null },
                { name: 'type', decltype: null },
              ],
              rows: [
                [text('orders'), text('table')],
                [text('recent'), text('view')],
              ],
            };
          }
          if (statement.sql.includes('pragma_table_info')) {
            return {
              cols: ['name', 'type', 'notnull', 'pk', 'dflt_value'].map((name) => ({
                name,
                decltype: null,
              })),
              rows: [
                [text('id'), text('INTEGER'), int(0), int(1), { type: 'null' }],
                [text('note'), text('TEXT'), int(0), int(0), text("'x'")],
              ],
            } satisfies FakeResult;
          }
          return {};
        },
      });
      const session = await open();
      expect(await session.metadata.listTables({})).toEqual([
        { name: 'orders', kind: 'table' },
        { name: 'recent', kind: 'view' },
      ]);
      const columns = await session.metadata.listColumns({ name: 'orders' });
      expect(columns).toEqual([
        { name: 'id', dataType: 'integer', nullable: true, primaryKey: true },
        {
          name: 'note',
          dataType: 'text',
          nullable: true,
          primaryKey: false,
          defaultValue: "'x'",
        },
      ]);
      // The table name is bound, not pasted in.
      const lookup = fake.records
        .flatMap((record) => record.requests)
        .find((request) => request.stmt?.sql.includes('pragma_table_info'));
      expect(lookup?.stmt?.args).toEqual([{ type: 'text', value: 'orders' }]);
    });

    it('has no databases and no schemas', async () => {
      await serve();
      const session = await open();
      expect(await session.metadata.listDatabases()).toEqual([]);
      await expect(session.metadata.listSchemas()).rejects.toMatchObject({ code: 'unsupported' });
    });
  });
});
