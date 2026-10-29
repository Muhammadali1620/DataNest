import { afterEach, describe, expect, it } from 'vitest';
import { formatPretty } from '../../../src/core/mongo/shell-format';
import { parseDocument, parseValue } from '../../../src/core/mongo/shell-parse';
import { doc, int32, numberField, sameValue, str } from '../../../src/core/mongo/value';
import { driver } from '../../../src/drivers/mongodb';
import type { MongoSession } from '../../../src/drivers/mongo-driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { TEST_MONGO } from '../../helpers/mongo-servers';

// docker/compose.yml `mongodb` (V7.5): the driver against a real MongoDB 8.2 replica set.
const opened: MongoSession[] = [];

function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'it',
    name: 'it',
    driver: 'mongodb',
    host: TEST_MONGO.host,
    port: TEST_MONGO.port,
    user: TEST_MONGO.user.name,
    password: TEST_MONGO.user.password,
    options: { connectTimeout: 5 },
    ...overrides,
  };
}

async function open(overrides: Partial<ResolvedConnectionConfig> = {}): Promise<MongoSession> {
  const session = await driver.openSession(config(overrides));
  opened.push(session);
  return session;
}

afterEach(async () => {
  for (const session of opened.splice(0)) {
    await session.close();
  }
});

describe('MongoDB connections (V7.5)', () => {
  it('signs in and says who the server is', async () => {
    const session = await open();
    expect(session.mode).toBe('direct');
    expect(session.server).toEqual({
      version: expect.stringMatching(/^8\.2\./) as unknown,
      topology: 'replicaSet',
      setName: TEST_MONGO.replicaSet,
    });
  });

  it('finds the primary of the replica set from its seed member', async () => {
    const session = await open({
      host: 'localhost',
      mongo: { mode: 'replicaSet', replicaSet: TEST_MONGO.replicaSet },
    });
    expect(session.mode).toBe('replicaSet');
    expect(session.server.topology).toBe('replicaSet');
    expect(numberField(await session.command('admin', doc([['ping', int32(1)]])), 'ok')).toBe(1);
  });

  it('refuses a replica set name the members do not have', async () => {
    await expect(
      open({
        host: 'localhost',
        mongo: { mode: 'replicaSet', replicaSet: 'other' },
        options: { connectTimeout: 2 },
      }),
    ).rejects.toMatchObject({ code: 'connection-failed' });
  });

  it('refuses a wrong password as a failed sign-in', async () => {
    await expect(open({ password: 'wrong' })).rejects.toMatchObject({ code: 'auth-failed' });
  });

  it('signs in to the database that holds the user', async () => {
    await expect(open({ database: 'shop' })).rejects.toMatchObject({ code: 'auth-failed' });
    const session = await open({
      database: 'shop',
      mongo: { mode: 'direct', authSource: 'admin' },
    });
    expect((await session.listDatabases()).map((one) => one.name)).toContain('shop');
  });

  it('reports a server that is not there as a failed connection', async () => {
    await expect(open({ port: 7999, options: { connectTimeout: 1 } })).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('ECONNREFUSED') as unknown,
    });
  });

  it('speaks TLS in every mode, and says why a certificate is refused', async () => {
    const ca = TEST_MONGO.tls.ca;
    expect(await open({ ssl: { mode: 'require' } })).toBeDefined();
    expect(await open({ ssl: { mode: 'verify-ca', ca } })).toBeDefined();
    expect(await open({ host: 'localhost', ssl: { mode: 'verify-full', ca } })).toBeDefined();
    await expect(
      open({ ssl: { mode: 'verify-full' }, options: { connectTimeout: 2 } }),
    ).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining('not trusted') as unknown,
    });
    await expect(
      open({
        ssl: { mode: 'verify-ca', ca: TEST_MONGO.tls.otherCa },
        options: { connectTimeout: 2 },
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining('not trusted') as unknown });
  });

  it('checks the name of the certificate against the server’s real name through a tunnel', async () => {
    // The local port stands for a tunnel; the certificate is issued for localhost.
    expect(
      await open({
        tlsServerName: 'localhost',
        ssl: { mode: 'verify-full', ca: TEST_MONGO.tls.ca },
      }),
    ).toBeDefined();
    await expect(
      open({
        tlsServerName: 'db.example.com',
        ssl: { mode: 'verify-full', ca: TEST_MONGO.tls.ca },
        options: { connectTimeout: 2 },
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining('not issued for "db.example.com"') as unknown,
    });
  });

  it('signs in with a client certificate (X.509)', async () => {
    const session = await open({
      user: undefined,
      password: undefined,
      ssl: {
        mode: 'verify-ca',
        ca: TEST_MONGO.tls.ca,
        cert: TEST_MONGO.tls.cert,
        key: TEST_MONGO.tls.key,
      },
      mongo: { mode: 'direct', authMechanism: 'MONGODB-X509' },
    });
    const status = await session.command('admin', doc([['connectionStatus', int32(1)]]));
    expect(formatPretty(status)).toContain(TEST_MONGO.certificateUser);
  });
});

describe('MongoDB documents (V7.5)', () => {
  it('reads every BSON type of the seed in its field order, and writes it back the same', async () => {
    const session = await open();
    const cursor = await session.openCursor('types', { kind: 'find', collection: 'values' });
    const { documents, done } = await cursor.next(10);
    expect(done).toBe(true);
    const [first] = documents;
    if (first === undefined) {
      throw new Error('no document');
    }
    const names = first.document.fields.map(([name]) => name);
    expect(names.slice(0, 2)).toEqual(['_id', '12']);
    expect(names).toContain('dotted.name');
    expect(names).toContain('$dollar');
    const text = formatPretty(first.document);
    for (const part of [
      'int64: NumberLong("9223372036854775807")',
      'decimal: NumberDecimal("1234567890.123456789012345678")',
      'doubleWhole: 2.0',
      'doubleNegZero: -0.0',
      'dateOld: new Date(-62198755200000)',
      'uuid: UUID("3b241101-e2bb-4255-8caf-4136c566a962")',
      'regex: /ab\\/c+/i',
      'timestamp: Timestamp(1700000000, 7)',
    ]) {
      expect(text).toContain(part);
    }
    // What the shell syntax says is the same BSON: parse it and compare.
    expect(sameValue(parseValue(text), first.document)).toBe(true);
    // A copy written through the driver comes back byte for byte the same value.
    await session.command('scratch', doc([['drop', str('copies')]])).catch(() => undefined);
    await session.command(
      'scratch',
      doc([
        ['insert', str('copies')],
        ['documents', { type: 'array', items: [first.document] }],
      ]),
    );
    const copy = await session.openCursor('scratch', { kind: 'find', collection: 'copies' });
    const [back] = (await copy.next(1)).documents;
    expect(back !== undefined && sameValue(back.document, first.document)).toBe(true);
    await session.command('scratch', doc([['dropDatabase', int32(1)]]));
  });

  it('reads a cursor in batches with filter, sort, projection, skip and limit', async () => {
    const session = await open();
    const cursor = await session.openCursor('shop', {
      kind: 'find',
      collection: 'orders',
      filter: parseDocument('{ status: "new" }'),
      sort: parseDocument('{ _id: -1 }'),
      projection: parseDocument('{ _id: 1, status: 1 }'),
      skip: 2,
      limit: 150,
    });
    const first = await cursor.next(100);
    expect(first.done).toBe(false);
    expect(first.documents).toHaveLength(100);
    expect(first.documents[0]?.document.fields.map(([name]) => name)).toEqual(['_id', 'status']);
    expect(numberField(first.documents[0]?.document ?? doc([]), '_id')).toBe(247);
    const rest = await cursor.next(100);
    expect(rest.documents).toHaveLength(50);
    expect(rest.done).toBe(true);
    await cursor.close();
  });

  it('runs an aggregation, on a collection and on the database', async () => {
    const session = await open();
    const grouped = await session.openCursor('shop', {
      kind: 'aggregate',
      collection: 'orders',
      pipeline: [
        parseValue('{ $group: { _id: "$status", n: { $sum: 1 } } }'),
        parseValue('{ $sort: { _id: 1 } }'),
      ],
    });
    const { documents } = await grouped.next(10);
    expect(documents.map((one) => formatPretty(one.document).replace(/\s+/g, ' '))).toEqual([
      '{ _id: "new", n: 188 }',
      '{ _id: "shipped", n: 62 }',
    ]);
    const literal = await session.openCursor('admin', {
      kind: 'aggregate',
      pipeline: [parseValue('{ $documents: [{ a: 1 }] }')],
    });
    expect((await literal.next(5)).documents).toHaveLength(1);
  });

  it('turns server errors into DbErrors with their kind', async () => {
    const session = await open();
    await expect(session.command('shop', doc([['nosuch', int32(1)]]))).rejects.toMatchObject({
      code: 'syntax',
    });
    const cursor = await session.openCursor('shop', {
      kind: 'find',
      collection: 'orders',
      filter: parseDocument('{ $bad: 1 }'),
    });
    await expect(cursor.next(1)).rejects.toMatchObject({ code: 'syntax' });
    // A write error comes inside an ok reply: the caller reads it.
    const duplicate = await session.command(
      'shop',
      doc([
        ['insert', str('customers')],
        ['documents', { type: 'array', items: [parseValue('{ _id: 1 }')] }],
      ]),
    );
    expect(formatPretty(duplicate)).toContain('E11000');
  });
});
