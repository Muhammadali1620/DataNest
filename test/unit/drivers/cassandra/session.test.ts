import { types } from 'cassandra-driver';
import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  consistencyByName,
  consistencyName,
  openCassandraSessionWith,
  PAGE_SIZE,
  ROW_BATCH_SIZE,
} from '../../../../src/drivers/cassandra/session';
import type { ExecuteEvent, Session } from '../../../../src/drivers/driver';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import {
  column,
  driverError,
  factoryFor,
  FakeCassandraClient,
  result,
  TYPE,
} from '../../../helpers/fake-cassandra';

const CONFIG: ResolvedConnectionConfig = {
  id: 'c',
  name: 'cassandra',
  driver: 'cassandra',
  host: 'db.example.com',
  port: 9142,
};

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

async function open(
  client = new FakeCassandraClient(),
  config: Partial<ResolvedConnectionConfig> = {},
) {
  const made = factoryFor(client);
  const session = await openCassandraSessionWith({ ...CONFIG, ...config }, made.factory);
  return { session, client, options: made.options };
}

describe('opening a session', () => {
  it('connects to the one address given, whatever address the nodes report', async () => {
    const { client, options } = await open();
    expect(client.connected).toBe(true);
    const seen = options();
    expect(seen.contactPoints).toEqual(['db.example.com:9142']);
    const translator = (
      seen.policies as { addressResolution: { translate: (...args: unknown[]) => void } }
    ).addressResolution;
    let endpoint = '';
    translator.translate('172.18.0.2', 9042, (value: string) => {
      endpoint = value;
    });
    expect(endpoint).toBe('db.example.com:9142');
  });

  it('uses the default port and host when none is given', async () => {
    const { options } = await open(new FakeCassandraClient(), { host: undefined, port: undefined });
    expect(options().contactPoints).toEqual(['localhost:9042']);
  });

  it('passes the sign-in, the keyspace and the timeouts', async () => {
    const { options } = await open(new FakeCassandraClient(), {
      user: 'app',
      password: 'pw',
      database: ' shop ',
      options: { connectTimeout: 3, queryTimeout: 7 },
    });
    expect(options().credentials).toEqual({ username: 'app', password: 'pw' });
    expect(options().keyspace).toBe('shop');
    expect(options().socketOptions).toMatchObject({ connectTimeout: 3000, readTimeout: 7000 });
  });

  it('sends no sign-in and no keyspace when none is named', async () => {
    const { options } = await open();
    expect(options().credentials).toBeUndefined();
    expect(options().keyspace).toBeUndefined();
    expect(options().sslOptions).toBeUndefined();
  });

  it('turns TLS on with the mode of the connection', async () => {
    const { options } = await open(new FakeCassandraClient(), { ssl: { mode: 'require' } });
    const ssl = options().sslOptions as { rejectUnauthorized: boolean; servername?: string };
    expect(ssl.rejectUnauthorized).toBe(false);
    expect(ssl.servername).toBe('db.example.com');
    const strict = await open(new FakeCassandraClient(), {
      ssl: { mode: 'verify-full' },
      host: '10.0.0.5',
      tlsServerName: 'cass.internal',
    });
    const verified = strict.options().sslOptions as {
      rejectUnauthorized: boolean;
      servername?: string;
    };
    expect(verified.rejectUnauthorized).toBe(true);
    expect(verified.servername).toBe('cass.internal');
  });

  it('names a refused sign-in and closes the client', async () => {
    const client = new FakeCassandraClient();
    client.connectError = Object.assign(driverError('NoHostAvailableError', 'All hosts failed'), {
      innerErrors: { a: driverError('AuthenticationError', 'Bad credentials') },
    });
    await expect(open(client)).rejects.toMatchObject({ code: 'auth-failed' });
    expect(client.shutdowns).toBe(1);
  });

  it('names an unreachable node', async () => {
    const client = new FakeCassandraClient();
    client.connectError = Object.assign(driverError('NoHostAvailableError', 'All hosts failed'), {
      innerErrors: { a: new Error('connect ECONNREFUSED') },
    });
    await expect(open(client)).rejects.toMatchObject({ code: 'connection-failed' });
  });
});

describe('running statements', () => {
  const COLUMNS = [column('id', TYPE.int), column('name', TYPE.text)];

  it('yields the columns with their types, the rows, and done', async () => {
    const { session, client } = await open();
    client.answers.set(
      'SELECT * FROM ks.t',
      result(COLUMNS, [
        [1, 'a'],
        [2, 'b'],
      ]),
    );
    const events = await collect(session, 'SELECT * FROM ks.t;');
    expect(events[0]).toEqual({
      kind: 'columns',
      columns: [
        { name: 'id', dataType: 'int' },
        { name: 'name', dataType: 'text' },
      ],
    });
    expect(rowsOf(events)).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(events.at(-1)).toEqual({ kind: 'done' });
  });

  it('converts values: exact integers, decimals, timestamps, collections', async () => {
    const { session, client } = await open();
    client.answers.set(
      'SELECT v FROM ks.t',
      result(
        [column('v', TYPE.bigint)],
        [[types.Long.fromString('9007199254740993')], [new Date('2024-01-01T00:00:00Z')], [[1, 2]]],
      ),
    );
    expect(rowsOf(await collect(session, 'SELECT v FROM ks.t'))).toEqual([
      [{ kind: 'bigint', text: '9007199254740993' }],
      [{ kind: 'datetime', text: '2024-01-01T00:00:00.000Z' }],
      [{ kind: 'json', text: '[1,2]' }],
    ]);
  });

  it('asks again with the page state until the last page, in order', async () => {
    const { session, client } = await open();
    client.answers.set('SELECT * FROM ks.t', (request) =>
      request.options.pageState === undefined
        ? result(COLUMNS, [[1, 'a']], { pageState: 'p2' })
        : request.options.pageState === 'p2'
          ? result(COLUMNS, [[2, 'b']], { pageState: 'p3' })
          : result(COLUMNS, [[3, 'c']], { pageState: '' }),
    );
    const events = await collect(session, 'SELECT * FROM ks.t');
    expect(rowsOf(events)).toEqual([
      [1, 'a'],
      [2, 'b'],
      [3, 'c'],
    ]);
    expect(events.filter((event) => event.kind === 'columns')).toHaveLength(1);
    expect(client.requests.map((request) => request.options.pageState)).toEqual([
      undefined,
      'p2',
      'p3',
    ]);
  });

  it('stops at the row limit, asks for no more rows than needed and no further page', async () => {
    const { session, client } = await open();
    client.answers.set('SELECT * FROM ks.t', (request) =>
      result(
        COLUMNS,
        Array.from({ length: request.options.fetchSize }, (_unused, index) => [index, 'x']),
        { pageState: 'more' },
      ),
    );
    const events = await collect(session, 'SELECT * FROM ks.t', 5);
    expect(rowsOf(events)).toHaveLength(5);
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.options.fetchSize).toBe(5);
  });

  it('cuts a page that came with more rows than the limit', async () => {
    const { session, client } = await open();
    client.answers.set(
      'SELECT * FROM ks.t',
      result(
        COLUMNS,
        [
          [1, 'a'],
          [2, 'b'],
          [3, 'c'],
        ],
        { pageState: 'more' },
      ),
    );
    const events = await collect(session, 'SELECT * FROM ks.t', 2);
    expect(rowsOf(events)).toEqual([
      [1, 'a'],
      [2, 'b'],
    ]);
    expect(client.requests).toHaveLength(1);
  });

  it('sends rows in batches', async () => {
    const { session, client } = await open();
    const many = Array.from({ length: ROW_BATCH_SIZE * 2 + 1 }, (_unused, index) => [index, 'x']);
    client.answers.set('SELECT * FROM ks.t', result(COLUMNS, many));
    const events = await collect(session, 'SELECT * FROM ks.t');
    expect(events.filter((event) => event.kind === 'rows')).toHaveLength(3);
    expect(rowsOf(events)).toHaveLength(many.length);
  });

  it('asks for whole pages when there is no limit', async () => {
    const { session, client } = await open();
    await collect(session, 'SELECT * FROM ks.t');
    expect(client.requests[0]?.options).toMatchObject({ fetchSize: PAGE_SIZE, prepare: false });
  });

  it('skips the rows a later page asks to skip, across pages', async () => {
    const { session, client } = await open();
    client.answers.set('SELECT * FROM ks.t LIMIT 5', (request) =>
      request.options.pageState === undefined
        ? result(
            COLUMNS,
            [
              [1, 'a'],
              [2, 'b'],
            ],
            { pageState: 'p2' },
          )
        : result(COLUMNS, [
            [3, 'c'],
            [4, 'd'],
            [5, 'e'],
          ]),
    );
    const events = await collect(session, 'SELECT * FROM ks.t LIMIT 5 /* datanest:skip=3 */', 2);
    expect(rowsOf(events)).toEqual([
      [4, 'd'],
      [5, 'e'],
    ]);
    expect(client.requests.every((request) => request.query === 'SELECT * FROM ks.t LIMIT 5')).toBe(
      true,
    );
  });

  it('says done and nothing else for a statement that returns no rows', async () => {
    const { session } = await open();
    const events = await collect(session, 'INSERT INTO ks.t (id) VALUES (1)');
    expect(events).toEqual([{ kind: 'done' }]);
  });

  it('puts the warnings of the server in the notice', async () => {
    const { session, client } = await open();
    client.answers.set(
      'SELECT * FROM ks.t',
      result(COLUMNS, [], { info: { warnings: ['Aggregation query used without partition key'] } }),
    );
    const events = await collect(session, 'SELECT * FROM ks.t');
    expect(events.at(-1)).toEqual({
      kind: 'done',
      notice: 'Aggregation query used without partition key',
    });
  });

  it('turns every failure into a DbError', async () => {
    const { session, client } = await open();
    client.answers.set(
      'SELECT nope',
      driverError('ResponseError', 'Undefined column nope', 0x2200),
    );
    await expect(collect(session, 'SELECT nope')).rejects.toMatchObject({ code: 'syntax' });
    client.answers.set('SELECT again', new Error('boom'));
    await expect(collect(session, 'SELECT again')).rejects.toBeInstanceOf(DbError);
  });

  it('runs one statement at a time, in the order given', async () => {
    const { session, client } = await open();
    const order: string[] = [];
    client.onExecute = async (request) => {
      order.push(`start ${request.query}`);
      await new Promise((resolve) => setTimeout(resolve, request.query === 'SELECT 1' ? 20 : 0));
      order.push(`end ${request.query}`);
    };
    await Promise.all([collect(session, 'SELECT 1'), collect(session, 'SELECT 2')]);
    expect(order).toEqual(['start SELECT 1', 'end SELECT 1', 'start SELECT 2', 'end SELECT 2']);
  });
});

describe('cancelling', () => {
  it('lets the page in flight finish, drops its rows and asks for no more', async () => {
    const { session, client } = await open();
    client.answers.set(
      'SELECT * FROM ks.t',
      result([column('id', TYPE.int)], [[1]], { pageState: 'p2' }),
    );
    client.onExecute = async () => {
      await session.cancel();
    };
    await expect(collect(session, 'SELECT * FROM ks.t')).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(client.requests).toHaveLength(1);
  });

  it('does not hold the next statement against the session', async () => {
    const { session, client } = await open();
    await session.cancel();
    client.answers.set('SELECT 1', result([column('a', TYPE.int)], [[1]]));
    expect(rowsOf(await collect(session, 'SELECT 1'))).toEqual([[1]]);
  });
});

describe('CONSISTENCY', () => {
  it('names the level, shows it, and sends it with the next statements', async () => {
    const { session, client } = await open();
    expect((await collect(session, 'CONSISTENCY'))[0]).toEqual({
      kind: 'done',
      notice: 'Consistency level: LOCAL_ONE',
    });
    expect(await collect(session, 'CONSISTENCY local_quorum;')).toEqual([
      { kind: 'done', notice: 'Consistency level: LOCAL_QUORUM' },
    ]);
    await collect(session, 'SELECT 1');
    expect(client.requests.at(-1)?.options.consistency).toBe(types.consistencies.localQuorum);
    await collect(session, 'consistency all');
    await collect(session, 'SELECT 2');
    expect(client.requests.at(-1)?.options.consistency).toBe(types.consistencies.all);
  });

  it('sends no level before one is set', async () => {
    const { session, client } = await open();
    await collect(session, 'SELECT 1');
    expect(client.requests[0]?.options.consistency).toBeUndefined();
  });

  it('refuses a level it does not know, and SERIAL CONSISTENCY', async () => {
    const { session } = await open();
    await expect(collect(session, 'CONSISTENCY sometimes')).rejects.toMatchObject({
      code: 'syntax',
    });
    await expect(collect(session, 'SERIAL CONSISTENCY SERIAL')).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('reads the names both ways', () => {
    expect(consistencyByName('QUORUM')).toBe(types.consistencies.quorum);
    expect(consistencyByName('each_quorum')).toBe(types.consistencies.eachQuorum);
    expect(consistencyByName('Local One')).toBe(types.consistencies.localOne);
    expect(consistencyByName('nope')).toBeUndefined();
    expect(consistencyName(types.consistencies.localSerial)).toBe('LOCAL_SERIAL');
    expect(consistencyName(types.consistencies.one)).toBe('ONE');
    expect(consistencyName(9999)).toBe('9999');
  });
});

describe('queryRows and closing', () => {
  it('reads every page, with the parameters', async () => {
    const { session, client } = await open();
    client.answers.set('SELECT a FROM t WHERE k = ?', (request) =>
      request.options.pageState === undefined
        ? result([column('a', TYPE.text)], [['x']], { pageState: 'p2' })
        : result([column('a', TYPE.text)], [['y']]),
    );
    const rows = await (
      session as unknown as { queryRows(q: string, p: unknown[]): Promise<unknown[][]> }
    ).queryRows('SELECT a FROM t WHERE k = ?', ['v']);
    expect(rows).toEqual([['x'], ['y']]);
    expect(client.requests[0]?.params).toEqual(['v']);
  });

  it('shuts the client down once, and refuses work afterwards', async () => {
    const { session, client } = await open();
    await session.close();
    await session.close();
    expect(client.shutdowns).toBe(1);
    await expect(collect(session, 'SELECT 1')).rejects.toMatchObject({ code: 'internal' });
    await expect(
      (session as unknown as { queryRows(q: string): Promise<unknown> }).queryRows('SELECT 1'),
    ).rejects.toMatchObject({ code: 'internal' });
  });
});
