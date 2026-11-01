import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { ExecuteEvent, Session } from '../../../../src/drivers/driver';
import { driver } from '../../../../src/drivers/influxdb';
import { languageOf } from '../../../../src/drivers/influxdb/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeInflux, fluxTable } from '../../../helpers/fake-influx';

const TOKEN = 'secret-token';

let server: FakeInflux;
const sessions: Session[] = [];

function config(over: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'c',
    name: 'Influx',
    driver: 'influxdb',
    host: '127.0.0.1',
    port: server.port,
    user: 'acme',
    password: TOKEN,
    database: 'metrics',
    ...over,
  };
}

async function open(over: Partial<ResolvedConnectionConfig> = {}): Promise<Session> {
  const session = await driver.openSession(config(over));
  sessions.push(session);
  return session;
}

async function collect(session: Session, sql: string, rowLimit?: number): Promise<ExecuteEvent[]> {
  const events: ExecuteEvent[] = [];
  for await (const event of session.execute(sql, rowLimit === undefined ? {} : { rowLimit })) {
    events.push(event);
  }
  return events;
}

const USAGE = fluxTable(
  ['result', 'table', '_time', '_value', 'host'],
  ['string', 'long', 'dateTime:RFC3339', 'double', 'string'],
  [
    ['', '0', '2024-05-01T10:00:00Z', '1.5', 'a'],
    ['', '0', '2024-05-01T10:01:00Z', '2.5', 'a'],
  ],
  ['_result', '', '', '', ''],
);

beforeEach(async () => {
  server = new FakeInflux({ token: TOKEN });
  await server.start();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  await server.stop();
});

describe('languageOf', () => {
  it('knows InfluxQL by its first word and calls the rest Flux', () => {
    expect(languageOf('SELECT * FROM cpu')).toBe('influxql');
    expect(languageOf('  show measurements')).toBe('influxql');
    expect(languageOf('-- note\nSELECT 1')).toBe('influxql');
    expect(languageOf('from(bucket: "b") |> range(start: -1h)')).toBe('flux');
    expect(languageOf('// note\nfrom(bucket: "b")')).toBe('flux');
    expect(
      languageOf('import "influxdata/influxdb/schema"\nschema.measurements(bucket: "b")'),
    ).toBe('flux');
    expect(languageOf('')).toBe('flux');
  });
});

describe('opening a session', () => {
  it('checks the address, the token and the organization with one call', async () => {
    await open();
    expect(server.received).toHaveLength(1);
    expect(server.received[0]).toMatchObject({
      method: 'GET',
      path: '/api/v2/buckets',
      query: { limit: '1', org: 'acme' },
      authorization: `Token ${TOKEN}`,
    });
  });

  it('is refused with a clear error for a wrong token', async () => {
    await expect(open({ password: 'wrong' })).rejects.toMatchObject({
      name: 'DbError',
      code: 'auth-failed',
    });
  });

  it('says so when nothing listens at the address', async () => {
    const port = server.port;
    await server.stop();
    await expect(open({ port })).rejects.toMatchObject({ code: 'connection-failed' });
    server = new FakeInflux({ token: TOKEN });
    await server.start();
  });

  it('works without a token against a server that asks for none', async () => {
    await server.stop();
    server = new FakeInflux();
    await server.start();
    const session = await open({ password: undefined });
    expect(server.received[0]?.authorization).toBeUndefined();
    await session.close();
  });

  it('leaves the organization out when the connection has none', async () => {
    await open({ user: '' });
    expect(server.received[0]?.query.org).toBeUndefined();
  });
});

describe('running Flux', () => {
  it('posts the query as JSON for the organization and streams the result', async () => {
    server.flux('range', { body: USAGE });
    const session = await open();
    const events = await collect(session, 'from(bucket: "metrics") |> range(start: -1h)');
    const sent = server.last();
    expect(sent).toMatchObject({ method: 'POST', path: '/api/v2/query', query: { org: 'acme' } });
    expect(JSON.parse(sent?.body ?? '{}')).toMatchObject({
      query: 'from(bucket: "metrics") |> range(start: -1h)',
      type: 'flux',
      dialect: { header: true, annotations: ['datatype', 'default'] },
    });
    expect(events).toEqual([
      {
        kind: 'columns',
        columns: [
          { name: 'table', dataType: 'long' },
          { name: '_time', dataType: 'dateTime' },
          { name: '_value', dataType: 'double' },
          { name: 'host', dataType: 'string' },
        ],
      },
      {
        kind: 'rows',
        rows: [
          [0, { kind: 'datetime', text: '2024-05-01T10:00:00Z' }, 1.5, 'a'],
          [0, { kind: 'datetime', text: '2024-05-01T10:01:00Z' }, 2.5, 'a'],
        ],
      },
      { kind: 'done' },
    ]);
  });

  it('batches rows and stops reading at the row limit', async () => {
    const rows = Array.from({ length: 450 }, (_, index) => [
      '',
      '0',
      '2024-05-01T10:00:00Z',
      String(index),
      'a',
    ]);
    server.flux('many', {
      body: fluxTable(
        ['result', 'table', '_time', '_value', 'host'],
        ['string', 'long', 'dateTime:RFC3339', 'long', 'string'],
        rows,
        ['_result', '', '', '', ''],
      ),
    });
    const session = await open();
    const all = await collect(session, 'many');
    expect(all.flatMap((event) => (event.kind === 'rows' ? [event.rows.length] : []))).toEqual([
      200, 200, 50,
    ]);
    const limited = await collect(session, 'many', 250);
    const counted = limited.reduce(
      (sum, event) => sum + (event.kind === 'rows' ? event.rows.length : 0),
      0,
    );
    expect(counted).toBe(250);
    expect(limited.at(-1)).toEqual({ kind: 'done' });
  });

  it('gives only done for an empty answer', async () => {
    server.flux('empty', { body: '' });
    const session = await open();
    expect(await collect(session, 'empty')).toEqual([{ kind: 'done' }]);
  });

  it('leaves out tables with other columns and says how many', async () => {
    const other = fluxTable(
      ['result', 'table', 'name'],
      ['string', 'long', 'string'],
      [['', '1', 'x']],
      ['_result', '', ''],
    );
    server.flux('two', { body: USAGE + other });
    const session = await open();
    const events = await collect(session, 'two');
    const done = events.at(-1);
    expect(done?.kind).toBe('done');
    expect(done?.kind === 'done' ? done.notice : '').toContain('1 more tables');
    expect(events.filter((event) => event.kind === 'columns')).toHaveLength(1);
  });

  it('joins tables with the same columns into one result', async () => {
    server.flux('same', { body: USAGE + USAGE });
    const session = await open();
    const events = await collect(session, 'same');
    const rows = events.flatMap((event) => (event.kind === 'rows' ? event.rows : []));
    expect(rows).toHaveLength(4);
    expect(events.filter((event) => event.kind === 'columns')).toHaveLength(1);
  });

  it('turns a failed query into an error with the words of the server', async () => {
    server.flux('bad', {
      status: 400,
      body: JSON.stringify({
        code: 'invalid',
        message: 'compilation failed: error @1:1-1:4: undefined identifier bad',
      }),
    });
    const session = await open();
    const failure: unknown = await collect(session, 'bad').catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: 'syntax' });
    expect((failure as Error).message).toContain('undefined identifier');
  });

  it('reads an error table inside a good answer', async () => {
    server.flux('late', { body: ',error,reference\r\n,"runtime error",1\r\n\r\n' });
    const session = await open();
    await expect(collect(session, 'late')).rejects.toBeInstanceOf(DbError);
  });

  it('reads a streamed answer that arrives in pieces', async () => {
    const half = Math.floor(USAGE.length / 2);
    server.flux('slow', { body: '', chunks: [USAGE.slice(0, half), USAGE.slice(half)], holdMs: 5 });
    const session = await open();
    const events = await collect(session, 'slow');
    expect(events.flatMap((event) => (event.kind === 'rows' ? event.rows : []))).toHaveLength(2);
  });
});

describe('running InfluxQL', () => {
  const SERIES = JSON.stringify({
    results: [
      {
        statement_id: 0,
        series: [
          { name: 'cpu', columns: ['time', 'usage'], values: [['2024-05-01T10:00:00Z', 1.5]] },
        ],
      },
    ],
  });

  it('posts the statement as a form on the database of the session, chunked', async () => {
    server.influxql('FROM "cpu"', { body: `${SERIES}\n` });
    const session = await open();
    const events = await collect(session, 'SELECT * FROM "cpu" LIMIT 5');
    const sent = server.last();
    expect(sent).toMatchObject({
      method: 'POST',
      path: '/query',
      query: { db: 'metrics', chunked: 'true' },
    });
    expect(new URLSearchParams(sent?.body).get('q')).toBe('SELECT * FROM "cpu" LIMIT 5');
    expect(events).toEqual([
      {
        kind: 'columns',
        columns: [
          { name: 'time', dataType: 'dateTime' },
          { name: 'usage', dataType: 'float' },
        ],
      },
      { kind: 'rows', rows: [[{ kind: 'datetime', text: '2024-05-01T10:00:00Z' }, 1.5]] },
      { kind: 'done' },
    ]);
  });

  it('runs on the database the connection names, or none', async () => {
    server.influxql('SHOW', { body: '{"results":[{"statement_id":0}]}\n' });
    const session = await open({ database: undefined });
    await collect(session, 'SHOW DATABASES');
    expect(server.last()?.query.db).toBeUndefined();
  });

  it('turns a statement error into an error', async () => {
    server.influxql('SELEC', {
      body: '{"error":"error parsing query: found SELEC, expected SELECT"}\n',
    });
    const session = await open();
    await expect(collect(session, 'SHOW SELEC')).rejects.toMatchObject({ code: 'syntax' });
  });

  it('reports a database that has no mapping as not found', async () => {
    server.influxql('cpu', { status: 404, body: '{"error":"database not found: \\"metrics\\""}' });
    const session = await open();
    await expect(collect(session, 'SELECT * FROM cpu')).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('a read-only connection', () => {
  it('refuses a statement that could change data, before it is sent', async () => {
    const session = await open({ readOnly: true });
    const before = server.received.length;
    await expect(collect(session, 'DROP MEASUREMENT cpu')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(
      collect(session, 'from(bucket: "a") |> range(start: -1h) |> to(bucket: "b")'),
    ).rejects.toMatchObject({ code: 'permission-denied' });
    expect(server.received.length).toBe(before);
  });

  it('lets queries through, Flux and InfluxQL', async () => {
    server.flux('range', { body: USAGE });
    server.influxql('SHOW', { body: '{"results":[{"statement_id":0}]}\n' });
    const session = await open({ readOnly: true });
    await expect(collect(session, 'from(bucket: "a") |> range(start: -1h)')).resolves.toBeDefined();
    await expect(collect(session, 'SHOW MEASUREMENTS')).resolves.toBeDefined();
  });
});

describe('cancelling and closing', () => {
  it('cancels a running query with a cancelled error and stays usable', async () => {
    server.flux('hang', { body: '', chunks: [USAGE.slice(0, 40), USAGE.slice(40)], holdMs: 400 });
    server.flux('range', { body: USAGE });
    const session = await open();
    const running = collect(session, 'hang');
    await new Promise((resolve) => setTimeout(resolve, 80));
    await session.cancel();
    await expect(running).rejects.toMatchObject({ code: 'cancelled' });
    const again = await collect(session, 'range');
    expect(again.some((event) => event.kind === 'rows')).toBe(true);
  });

  it('cancelling an idle session does nothing', async () => {
    const session = await open();
    await expect(session.cancel()).resolves.toBeUndefined();
  });

  it('refuses statements once closed, and closing twice is fine', async () => {
    const session = await open();
    await session.close();
    await session.close();
    await expect(collect(session, 'from(bucket: "a")')).rejects.toMatchObject({ code: 'internal' });
  });

  it('runs statements one at a time', async () => {
    server.flux('one', { body: USAGE.slice(0, 0), chunks: [USAGE], holdMs: 60 });
    server.flux('two', { body: USAGE });
    const session = await open();
    const order: string[] = [];
    await Promise.all([
      collect(session, 'one').then(() => order.push('one')),
      collect(session, 'two').then(() => order.push('two')),
    ]);
    expect(order).toEqual(['one', 'two']);
  });
});

describe('capabilities', () => {
  it('has buckets as databases, sessions per bucket, no transactions', () => {
    expect(driver.capabilities).toMatchObject({
      databases: true,
      schemas: false,
      databaseScopedSessions: true,
      cancel: true,
      transactions: false,
    });
    expect(driver.id).toBe('influxdb');
  });
});
