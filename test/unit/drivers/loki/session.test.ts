import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ExecuteEvent, Session } from '../../../../src/drivers/driver';
import { driver } from '../../../../src/drivers/loki';
import { SERVER_LINE_LIMIT } from '../../../../src/drivers/loki/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeLoki, matrix, streams, vector } from '../../../helpers/fake-loki';

let server: FakeLoki;
const sessions: Session[] = [];

function config(over: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'c',
    name: 'Loki',
    driver: 'loki',
    host: '127.0.0.1',
    port: server.port,
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

function rowsOf(events: readonly ExecuteEvent[]): unknown[][] {
  return events.flatMap((event) =>
    event.kind === 'rows' ? event.rows.map((row) => [...row]) : [],
  );
}

function doneOf(events: readonly ExecuteEvent[]): Extract<ExecuteEvent, { kind: 'done' }> {
  const done = events.at(-1);
  if (done?.kind !== 'done') {
    throw new Error('no done event');
  }
  return done;
}

const T = (n: number): string => `17300000000000000${String(n).padStart(2, '0')}`;
const THREE = streams([
  {
    labels: { app: 'shop' },
    lines: [
      [T(1), 'one'],
      [T(3), 'three'],
    ],
  },
  { labels: { app: 'api' }, lines: [[T(2), 'two']] },
]);

beforeEach(async () => {
  server = new FakeLoki();
  await server.start();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.close();
  }
  await server.stop();
});

describe('opening a session', () => {
  it('proves the address with a call for the labels of the last hour', async () => {
    await open();
    const call = server.calls('/loki/api/v1/labels')[0];
    expect(call).toBeDefined();
    const span = BigInt(call?.query.end ?? '0') - BigInt(call?.query.start ?? '0');
    expect(span).toBe(3_600_000_000_000n);
  });

  it('sends the tenant in X-Scope-OrgID', async () => {
    server = new FakeLoki({ tenant: 'acme' });
    await server.start();
    await open({ database: ' acme ' });
    expect(server.last()?.tenant).toBe('acme');
  });

  it('sends a user and password as basic authentication', async () => {
    server = new FakeLoki({ authorization: `Basic ${Buffer.from('ann:pw').toString('base64')}` });
    await server.start();
    await open({ user: 'ann', password: 'pw' });
    expect(server.last()?.authorization).toBe(`Basic ${Buffer.from('ann:pw').toString('base64')}`);
  });

  it('sends a password alone as a bearer token', async () => {
    server = new FakeLoki({ authorization: 'Bearer tok' });
    await server.start();
    await open({ password: 'tok' });
    expect(server.last()?.authorization).toBe('Bearer tok');
  });

  it('sends nothing when there is no sign-in and no tenant', async () => {
    await open({ user: '  ', password: '', database: ' ' });
    expect(server.last()?.authorization).toBeUndefined();
    expect(server.last()?.tenant).toBeUndefined();
  });

  it('says a refused sign-in, and leaves nothing open', async () => {
    server = new FakeLoki({ authorization: 'Bearer right' });
    await server.start();
    await expect(driver.openSession(config({ password: 'wrong' }))).rejects.toMatchObject({
      code: 'auth-failed',
    });
  });

  it('says a missing tenant the same way', async () => {
    server = new FakeLoki({ tenant: 'acme' });
    await server.start();
    await expect(driver.openSession(config())).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('says a server that is not there', async () => {
    await expect(driver.openSession(config({ port: 1 }))).rejects.toMatchObject({
      code: 'connection-failed',
    });
  });
});

describe('a log query', () => {
  it('asks the range, with a window of the last hour, newest first, and the default limit', async () => {
    server.query('{app="shop"}', { body: THREE });
    const session = await open();
    await collect(session, '{app="shop"}');
    const call = server.calls('/loki/api/v1/query_range')[0];
    expect(call?.query.query).toBe('{app="shop"}');
    expect(call?.query.direction).toBe('backward');
    expect(call?.query.limit).toBe('1001');
    expect(BigInt(call?.query.end ?? '0') - BigInt(call?.query.start ?? '0')).toBe(
      3_600_000_000_000n,
    );
    expect(call?.query.step).toBeUndefined();
  });

  it('answers columns, rows merged by time, and done', async () => {
    server.query('{app', { body: THREE });
    const session = await open();
    const events = await collect(session, '{app=~".+"}');
    expect(events.map((event) => event.kind)).toEqual(['columns', 'rows', 'done']);
    const columns = events[0];
    expect(columns?.kind === 'columns' && columns.columns.map((column) => column.name)).toEqual([
      'time',
      'ns',
      'labels',
      'line',
    ]);
    expect(rowsOf(events).map((row) => row[3])).toEqual(['three', 'two', 'one']);
    expect(doneOf(events).notice).toBeUndefined();
  });

  it('sends the rows in batches of 200', async () => {
    const lines: [string, string][] = Array.from({ length: 450 }, (_, index) => [
      `1730000000000${String(index).padStart(6, '0')}`,
      `line ${index}`,
    ]);
    server.query('{big', { body: streams([{ labels: { big: '1' }, lines }]) });
    const session = await open();
    const events = await collect(session, '{big="1"}', 450);
    const sizes = events.filter((event) => event.kind === 'rows').map((event) => event.rows.length);
    expect(sizes).toEqual([200, 200, 50]);
  });

  it('removes the directive comments from the query it sends', async () => {
    server.query('{app', { body: THREE });
    const session = await open();
    await collect(session, '# range: 6h\n# direction: forward\n{app="shop"} # note\n|= "x"');
    const call = server.calls('/loki/api/v1/query_range')[0];
    expect(call?.query.query).not.toContain('#');
    expect(call?.query.query).toContain('{app="shop"}');
    expect(call?.query.query).toContain('|= "x"');
  });

  it('applies the range, direction, step and limit of the directives', async () => {
    server.query('rate', { body: matrix([]) });
    const session = await open();
    await collect(
      session,
      '# range: 6h\n# step: 1m\n# direction: forward\n# limit: 50\nrate({app="shop"}[5m])',
    );
    const call = server.calls('/loki/api/v1/query_range')[0];
    expect(BigInt(call?.query.end ?? '0') - BigInt(call?.query.start ?? '0')).toBe(
      6n * 3_600_000_000_000n,
    );
    expect(call?.query.step).toBe('1m');
    expect(call?.query.direction).toBe('forward');
    expect(call?.query.limit).toBe('51');
  });

  it('uses a start and an end of its own', async () => {
    server.query('{app', { body: THREE });
    const session = await open();
    await collect(session, '# start: 2026-11-01T00:00:00Z\n# end: 2026-11-01T06:00:00Z\n{app="x"}');
    const call = server.calls('/loki/api/v1/query_range')[0];
    expect(call?.query.start).toBe('1793491200000000000');
    expect(call?.query.end).toBe('1793512800000000000');
  });

  it('lets the grid limit the rows below the limit of the statement', async () => {
    server.query('{app', { body: THREE });
    const session = await open();
    const events = await collect(session, '# limit: 500\n{app="x"}', 2);
    expect(server.calls('/loki/api/v1/query_range')[0]?.query.limit).toBe('3');
    expect(rowsOf(events)).toHaveLength(2);
  });

  it('tells when there were more lines in the window than were read', async () => {
    server.query('{app', { body: THREE });
    const session = await open();
    const events = await collect(session, '# limit: 2\n{app="x"}');
    expect(rowsOf(events)).toHaveLength(2);
    expect(doneOf(events).notice).toMatch(/more lines/u);
  });

  it('asks for no more than the server gives, and says so', async () => {
    const lines: [string, string][] = Array.from({ length: SERVER_LINE_LIMIT }, (_, index) => [
      `1730000000${String(index).padStart(9, '0')}`,
      `line ${index}`,
    ]);
    server.query('{big', { body: streams([{ labels: { big: '1' }, lines }]) });
    const session = await open();
    const events = await collect(session, '# limit: 20000\n{big="1"}', 20_000);
    expect(server.calls('/loki/api/v1/query_range')[0]?.query.limit).toBe(
      String(SERVER_LINE_LIMIT),
    );
    expect(rowsOf(events)).toHaveLength(SERVER_LINE_LIMIT);
    expect(doneOf(events).notice).toMatch(/at most 5000 lines/u);
  });

  it('goes by POST when the query is too long for an address', async () => {
    const long = `{app="x"} |~ "${'a'.repeat(5000)}"`;
    server.query('{app', { body: THREE });
    const session = await open();
    await collect(session, long);
    const call = server.calls('/loki/api/v1/query_range')[0];
    expect(call?.method).toBe('POST');
    expect(call?.query.query).toContain('a'.repeat(5000));
  });

  it('shows the words of Loki for a query it cannot parse', async () => {
    server.query('{app=', {
      status: 400,
      body: 'parse error at line 1, col 6: syntax error: unexpected $end, expecting STRING',
    });
    const session = await open();
    await expect(collect(session, '{app=')).rejects.toMatchObject({
      code: 'syntax',
      message: expect.stringContaining('unexpected $end') as string,
    });
  });

  it('refuses a bad directive before it asks anything', async () => {
    const session = await open();
    const before = server.received.length;
    await expect(collect(session, '# range: soon\n{app="x"}')).rejects.toMatchObject({
      code: 'syntax',
    });
    expect(server.received).toHaveLength(before);
  });
});

describe('a metric query', () => {
  it('answers a row per sample, oldest first', async () => {
    server.query('rate', {
      body: matrix([
        {
          metric: { app: 'shop' },
          values: [
            [1730000060, '2'],
            [1730000000, '1'],
          ],
        },
      ]),
    });
    const session = await open();
    const events = await collect(session, 'sum by (app) (rate({app="shop"}[5m]))');
    const columns = events[0];
    expect(columns?.kind === 'columns' && columns.columns.map((column) => column.name)).toEqual([
      'time',
      'ns',
      'value',
      'labels',
    ]);
    expect(rowsOf(events).map((row) => row[2])).toEqual([1, 2]);
  });

  it('reads a vector', async () => {
    server.query('sum', { body: vector([{ metric: {}, value: [1730000000, '9'] }]) });
    const session = await open();
    expect(rowsOf(await collect(session, 'sum(count_over_time({a="b"}[1m]))'))).toHaveLength(1);
  });
});

describe('session defaults', () => {
  it('a statement of directives alone sets them for the statements after it', async () => {
    server.query('{app', { body: THREE });
    const session = await open();
    const events = await collect(session, '# range: 12h\n# direction: forward\n# limit: 7');
    expect(events).toEqual([
      {
        kind: 'done',
        notice: expect.stringContaining('range 12h, direction forward, limit 7') as string,
      },
    ]);
    expect(server.calls('/loki/api/v1/query_range')).toHaveLength(0);
    await collect(session, '{app="x"}');
    const call = server.calls('/loki/api/v1/query_range')[0];
    expect(BigInt(call?.query.end ?? '0') - BigInt(call?.query.start ?? '0')).toBe(
      12n * 3_600_000_000_000n,
    );
    expect(call?.query.direction).toBe('forward');
    expect(call?.query.limit).toBe('8');
  });

  it('a directive on the statement itself wins over a default, for that statement only', async () => {
    server.query('{app', { body: THREE });
    const session = await open();
    await collect(session, '# range: 12h');
    await collect(session, '# range: 5m\n{app="x"}');
    await collect(session, '{app="x"}');
    const [first, second] = server.calls('/loki/api/v1/query_range');
    const span = (call: typeof first): bigint =>
      BigInt(call?.query.end ?? '0') - BigInt(call?.query.start ?? '0');
    expect(span(first)).toBe(300_000_000_000n);
    expect(span(second)).toBe(12n * 3_600_000_000_000n);
  });

  it('sets a step as well', async () => {
    server.query('rate', { body: matrix([]) });
    const session = await open();
    await collect(session, '# step: 30s');
    await collect(session, 'rate({a="b"}[1m])');
    expect(server.calls('/loki/api/v1/query_range')[0]?.query.step).toBe('30s');
  });

  it('says there is nothing to run for an empty statement', async () => {
    const session = await open();
    const events = await collect(session, '# just a note');
    expect(doneOf(events).notice).toMatch(/Nothing to run/u);
  });
});

describe('a label opened as a table', () => {
  it('reads a page of a label newest first, skipping the pages before', async () => {
    const lines: [string, string][] = Array.from({ length: 6 }, (_, index) => [
      T(index + 1),
      `line ${index + 1}`,
    ]);
    server.query('{app=~".+"}', { body: streams([{ labels: { app: 'x' }, lines }]) });
    const session = await open();
    const events = await collect(session, 'SELECT * FROM `app` LIMIT 2 OFFSET 2', 2);
    const call = server.calls('/loki/api/v1/query_range')[0];
    expect(call?.query.query).toBe('{app=~".+"}');
    // Loki is asked for the lines of the pages before as well, and the client skips them.
    expect(call?.query.limit).toBe('5');
    expect(rowsOf(events).map((row) => row[3])).toEqual(['line 4', 'line 3']);
  });

  it('reads the first page upwards when the grid sorts by time ascending', async () => {
    server.query('{app', { body: THREE });
    const session = await open();
    const events = await collect(session, 'SELECT * FROM `app` ORDER BY `time` ASC LIMIT 3', 3);
    expect(server.calls('/loki/api/v1/query_range')[0]?.query.direction).toBe('forward');
    expect(rowsOf(events).map((row) => row[3])).toEqual(['one', 'two', 'three']);
  });

  it('counts the lines of a label with a metric query', async () => {
    server.query('count_over_time', { body: vector([{ metric: {}, value: [1730000000, '42'] }]) });
    const session = await open();
    const events = await collect(session, 'SELECT COUNT(*) FROM `app`', 1);
    const call = server.calls('/loki/api/v1/query')[0];
    expect(call?.query.query).toBe('sum(count_over_time({app=~".+"}[3600s]))');
    expect(rowsOf(events)).toEqual([[42]]);
  });

  it('counts none when the label has no lines in the window', async () => {
    server.query('count_over_time', { body: vector([]) });
    const session = await open();
    expect(rowsOf(await collect(session, 'SELECT COUNT(*) FROM `app`', 1))).toEqual([[0]]);
  });

  it('uses the session range for a page and for the count', async () => {
    server.query('count_over_time', { body: vector([]) });
    const session = await open();
    await collect(session, '# range: 2h');
    await collect(session, 'SELECT COUNT(*) FROM `app`', 1);
    expect(server.calls('/loki/api/v1/query')[0]?.query.query).toContain('[7200s]');
  });

  it('refuses a filter', async () => {
    const session = await open();
    await expect(
      collect(session, "SELECT * FROM `app` WHERE `line` = 'x' LIMIT 5"),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});

describe('cancelling and closing', () => {
  it('cancels a query that never answers, and the session goes on', async () => {
    server.query('slow', { body: '', hang: true });
    server.query('{app', { body: THREE });
    const session = await open();
    const pending = collect(session, '{slow="1"}');
    const outcome = pending.then(
      () => 'finished',
      (error: unknown) => (error as { code?: string }).code,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await session.cancel();
    expect(await outcome).toBe('cancelled');
    expect(rowsOf(await collect(session, '{app="x"}'))).toHaveLength(3);
  });

  it('runs the statements of one session one after the other', async () => {
    server.query('slow', { body: THREE, holdMs: 150 });
    server.query('{app', { body: THREE });
    const session = await open();
    const order: string[] = [];
    const first = collect(session, '{slow="1"}').then(() => order.push('first'));
    const second = collect(session, '{app="x"}').then(() => order.push('second'));
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('refuses a statement after close, and closing twice is harmless', async () => {
    const session = await open();
    await session.close();
    await session.close();
    await expect(collect(session, '{app="x"}')).rejects.toMatchObject({ code: 'internal' });
  });

  it('cancelling an idle session does nothing', async () => {
    const session = await open();
    await expect(session.cancel()).resolves.toBeUndefined();
  });

  it('turns a connection that drops mid-query into a lost connection', async () => {
    server.query('slow', { body: '', hang: true });
    const session = await open();
    const pending = collect(session, '{slow="1"}').then(
      () => undefined,
      (error: unknown) => error,
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await server.stop();
    expect(await pending).toMatchObject({ code: 'connection-failed' });
    // The next test and the clean-up want a server that is running.
    server = new FakeLoki();
    await server.start();
  });
});

describe('the driver', () => {
  it('says what it is and what it cannot do', () => {
    expect(driver.id).toBe('loki');
    expect(driver.capabilities).toMatchObject({
      databases: false,
      schemas: false,
      cancel: true,
      transactions: false,
    });
  });
});
