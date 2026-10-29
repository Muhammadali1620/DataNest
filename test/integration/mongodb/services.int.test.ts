import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '../../../src/core/mongo/shell-parse';
import { driver } from '../../../src/drivers/mongodb';
import type { MongoSession } from '../../../src/drivers/mongo-driver';
import {
  collectionMarks,
  listMongoCollections,
  listMongoDatabases,
  listMongoIndexes,
} from '../../../src/services/mongodb/catalog';
import {
  createCollection,
  createDatabase,
  createIndex,
  dropCollection,
  dropDatabase,
  dropIndex,
  renameCollection,
} from '../../../src/services/mongodb/schema-edits';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { TEST_MONGO } from '../../helpers/mongo-servers';

// docker/compose.yml `mongodb` (V7.5): what the tree lists and changes on a real server.
const SCRATCH = 'datanest_it_schema';
const opened: MongoSession[] = [];
let root: MongoSession;

async function open(overrides: Partial<ResolvedConnectionConfig> = {}): Promise<MongoSession> {
  const session = await driver.openSession({
    id: 'it',
    name: 'it',
    driver: 'mongodb',
    host: TEST_MONGO.host,
    port: TEST_MONGO.port,
    user: TEST_MONGO.user.name,
    password: TEST_MONGO.user.password,
    ...overrides,
  });
  opened.push(session);
  return session;
}

beforeAll(async () => {
  root = await driver.openSession({
    id: 'root',
    name: 'root',
    driver: 'mongodb',
    host: TEST_MONGO.host,
    port: TEST_MONGO.port,
    user: TEST_MONGO.user.name,
    password: TEST_MONGO.user.password,
  });
  await dropDatabase(root, SCRATCH);
});

afterAll(async () => {
  await dropDatabase(root, SCRATCH);
  await root.close();
});

afterEach(async () => {
  for (const session of opened.splice(0)) {
    await session.close();
  }
});

describe('MongoDB catalog on the seed (V7.5)', () => {
  it('lists the databases of the seed', async () => {
    const names = (await listMongoDatabases(await open(), undefined)).map((one) => one.name);
    expect(names).toEqual(expect.arrayContaining(['admin', 'emptydb', 'shop', 'types']));
  });

  it('lists collections and views apart, with what sets them apart', async () => {
    const listing = await listMongoCollections(await open(), 'shop', false);
    expect(listing.collections.map((one) => one.name)).toEqual([
      'customers',
      'events',
      'metrics',
      'orders',
      'places',
      'validated',
    ]);
    expect(listing.views.map((one) => one.name)).toEqual(['big_orders']);
    const marks = Object.fromEntries(
      [...listing.collections, ...listing.views].map((one) => [one.name, collectionMarks(one)]),
    );
    expect(marks.events?.capped).toBe(true);
    expect(marks.metrics?.timeseries).toBe(true);
    expect(marks.validated?.validated).toBe(true);
    expect(marks.big_orders?.viewOn).toBe('orders');
    const withSystem = await listMongoCollections(await open(), 'shop', true);
    expect(withSystem.collections.map((one) => one.name)).toContain('system.views');
  });

  it('describes every kind of index of the seed', async () => {
    const session = await open();
    const customers = await listMongoIndexes(session, 'shop', 'customers');
    expect(customers.map((one) => [one.name, one.keys])).toEqual([
      ['_id_', '{ _id: 1 }'],
      ['city_1_name_-1', '{ city: 1, name: -1 }'],
      ['email_unique', '{ email: 1 }'],
      ['name_text', '{ _fts: "text", _ftsx: 1 }'],
    ]);
    expect(customers.find((one) => one.name === 'email_unique')?.unique).toBe(true);
    const orders = await listMongoIndexes(session, 'shop', 'orders');
    expect(orders.find((one) => one.name === 'createdAt_ttl')?.expireAfterSeconds).toBe(
      315_360_000,
    );
    expect(orders.find((one) => one.name === 'shipped_only')?.partial).toBe(
      '{ status: "shipped" }',
    );
    expect(orders.find((one) => one.name === 'customer_hashed')?.kind).toBe('hashed');
    const places = await listMongoIndexes(session, 'shop', 'places');
    expect(places.find((one) => one.name === 'location_2dsphere')?.kind).toBe('2dsphere');
  });

  it('lets a read-only user list what it may read', async () => {
    const reader = await open({
      user: TEST_MONGO.reader.name,
      password: TEST_MONGO.reader.password,
    });
    expect((await listMongoDatabases(reader, undefined)).map((one) => one.name)).toContain('shop');
    expect((await listMongoCollections(reader, 'shop', false)).collections.length).toBeGreaterThan(
      0,
    );
  });
});

describe('MongoDB structure changes (V7.5)', () => {
  it('creates a database with its first collection, renames and drops it', async () => {
    const session = await open();
    await createDatabase(session, SCRATCH, 'first');
    expect((await listMongoDatabases(session, undefined)).map((one) => one.name)).toContain(
      SCRATCH,
    );
    await renameCollection(session, SCRATCH, 'first', 'renamed');
    expect(
      (await listMongoCollections(session, SCRATCH, false)).collections.map((one) => one.name),
    ).toEqual(['renamed']);
    await createCollection(session, SCRATCH, 'taken');
    await expect(renameCollection(session, SCRATCH, 'renamed', 'taken')).rejects.toMatchObject({
      code: 'constraint',
    });
    await dropCollection(session, SCRATCH, 'taken');
    await dropDatabase(session, SCRATCH);
    expect((await listMongoDatabases(session, undefined)).map((one) => one.name)).not.toContain(
      SCRATCH,
    );
  });

  it('creates capped and time series collections the server describes as such', async () => {
    const session = await open();
    await createCollection(session, SCRATCH, 'log', {
      kind: 'capped',
      sizeBytes: 1024 * 1024,
      maxDocuments: 5,
    });
    await createCollection(session, SCRATCH, 'temps', {
      kind: 'timeseries',
      timeField: 'at',
      metaField: 'room',
    });
    const listing = await listMongoCollections(session, SCRATCH, false);
    const byName = new Map(listing.collections.map((one) => [one.name, one]));
    const log = byName.get('log');
    expect(log === undefined ? false : collectionMarks(log).capped).toBe(true);
    expect(byName.get('temps')?.type).toBe('timeseries');
    await expect(createCollection(session, SCRATCH, 'log')).rejects.toMatchObject({
      code: 'constraint',
    });
  });

  it('creates indexes with their options and drops them; _id_ stays', async () => {
    const session = await open();
    await createCollection(session, SCRATCH, 'users');
    await createIndex(
      session,
      SCRATCH,
      'users',
      parseDocument('{ email: 1 }'),
      parseDocument('{ unique: true }'),
    );
    await createIndex(
      session,
      SCRATCH,
      'users',
      parseDocument('{ seen: -1 }'),
      parseDocument(
        '{ name: "seen_ttl", expireAfterSeconds: 60, partialFilterExpression: { active: true } }',
      ),
    );
    const indexes = await listMongoIndexes(session, SCRATCH, 'users');
    expect(indexes.map((one) => one.name)).toEqual(['_id_', 'email_1', 'seen_ttl']);
    expect(indexes[1]?.unique).toBe(true);
    expect(indexes[2]).toMatchObject({ expireAfterSeconds: 60, partial: '{ active: true }' });
    await expect(
      createIndex(
        session,
        SCRATCH,
        'users',
        parseDocument('{ email: 1 }'),
        parseDocument('{ sparse: true }'),
      ),
    ).rejects.toMatchObject({ code: 'constraint' });
    await dropIndex(session, SCRATCH, 'users', 'email_1');
    await expect(dropIndex(session, SCRATCH, 'users', 'email_1')).rejects.toMatchObject({
      code: 'not-found',
    });
    expect((await listMongoIndexes(session, SCRATCH, 'users')).map((one) => one.name)).toEqual([
      '_id_',
      'seen_ttl',
    ]);
  });

  it('refuses a read-only user every change', async () => {
    const reader = await open({
      user: TEST_MONGO.reader.name,
      password: TEST_MONGO.reader.password,
    });
    await expect(createCollection(reader, SCRATCH, 'nope')).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await expect(dropCollection(reader, 'shop', 'orders')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});
