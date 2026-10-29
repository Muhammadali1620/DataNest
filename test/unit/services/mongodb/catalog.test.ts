import { describe, expect, it } from 'vitest';
import { bool, doc, int32, str } from '../../../../src/core/mongo/value';
import {
  collectionMarks,
  formatBytes,
  isSystemCollection,
  listMongoCollections,
  listMongoDatabases,
  listMongoIndexes,
  MONGO_SYSTEM_DATABASES,
  mongoIndexInfo,
} from '../../../../src/services/mongodb/catalog';
import { collection, FakeMongoSession, indexSpec } from '../../../helpers/fake-mongo';

describe('listMongoDatabases (V7.5)', () => {
  it('sorts the databases by name, numbers as numbers', async () => {
    const session = new FakeMongoSession();
    session.databases = [{ name: 'shop10' }, { name: 'admin' }, { name: 'Shop2', sizeOnDisk: 5 }];
    expect((await listMongoDatabases(session, undefined)).map((one) => one.name)).toEqual([
      'admin',
      'Shop2',
      'shop10',
    ]);
  });

  it('adds the database the connection names when the user may not list it', async () => {
    const session = new FakeMongoSession();
    session.databases = [{ name: 'other' }];
    expect(await listMongoDatabases(session, ' app ')).toEqual([
      { name: 'app' },
      { name: 'other' },
    ]);
    session.databases = [{ name: 'app', sizeOnDisk: 1 }];
    expect(await listMongoDatabases(session, 'app')).toEqual([{ name: 'app', sizeOnDisk: 1 }]);
  });

  it('knows the databases of the server itself', () => {
    expect(MONGO_SYSTEM_DATABASES).toEqual(['admin', 'config', 'local']);
  });
});

describe('listMongoCollections (V7.5)', () => {
  it('puts collections first and views after, each sorted, without system ones', async () => {
    const session = new FakeMongoSession();
    session.collections.set('shop', [
      collection('orders'),
      collection('big_orders', 'view'),
      collection('system.views'),
      collection('metrics', 'timeseries'),
      collection('a_view', 'view'),
    ]);
    const listing = await listMongoCollections(session, 'shop', false);
    expect(listing.collections.map((one) => one.name)).toEqual(['metrics', 'orders']);
    expect(listing.views.map((one) => one.name)).toEqual(['a_view', 'big_orders']);
    const all = await listMongoCollections(session, 'shop', true);
    expect(all.collections.map((one) => one.name)).toContain('system.views');
  });

  it('tells system collections by their prefix', () => {
    expect(isSystemCollection('system.buckets.metrics')).toBe(true);
    expect(isSystemCollection('systemic')).toBe(false);
  });

  it('marks capped, time series, validated collections and what a view reads', () => {
    expect(
      collectionMarks(collection('events', 'collection', doc([['capped', bool(true)]]))),
    ).toEqual({ capped: true, timeseries: false, validated: false });
    expect(collectionMarks(collection('m', 'timeseries')).timeseries).toBe(true);
    expect(
      collectionMarks(collection('v', 'collection', doc([['validator', doc([])]]))).validated,
    ).toBe(true);
    expect(
      collectionMarks(collection('big', 'view', doc([['viewOn', str('orders')]]))).viewOn,
    ).toBe('orders');
  });
});

describe('mongoIndexInfo (V7.5)', () => {
  it('describes keys and options', () => {
    const info = mongoIndexInfo(
      indexSpec('email_unique', doc([['email', int32(1)]]), [
        ['unique', bool(true)],
        ['sparse', bool(true)],
        ['hidden', bool(true)],
      ]),
    );
    expect(info).toEqual({
      name: 'email_unique',
      keys: '{ email: 1 }',
      primary: false,
      unique: true,
      sparse: true,
      hidden: true,
    });
  });

  it('reads TTL, partial filters and special kinds', () => {
    const info = mongoIndexInfo(
      indexSpec('ttl', doc([['createdAt', int32(1)]]), [
        ['expireAfterSeconds', int32(3600)],
        ['partialFilterExpression', doc([['status', str('shipped')]])],
      ]),
    );
    expect(info.expireAfterSeconds).toBe(3600);
    expect(info.partial).toBe('{ status: "shipped" }');
    expect(mongoIndexInfo(indexSpec('t', doc([['name', str('text')]]))).kind).toBe('text');
    expect(mongoIndexInfo(indexSpec('_id_', doc([['_id', int32(1)]]))).primary).toBe(true);
  });

  it('lists _id_ first, then the others by name', async () => {
    const session = new FakeMongoSession();
    session.indexes.set('shop.orders', [
      indexSpec('b', doc([['b', int32(1)]])),
      indexSpec('_id_', doc([['_id', int32(1)]])),
      indexSpec('a', doc([['a', int32(-1)]])),
    ]);
    expect((await listMongoIndexes(session, 'shop', 'orders')).map((one) => one.name)).toEqual([
      '_id_',
      'a',
      'b',
    ]);
  });
});

describe('formatBytes (V7.5)', () => {
  it.each([
    [0, '0 B'],
    [1023, '1023 B'],
    [1024, '1 KB'],
    [1536, '1.5 KB'],
    [430_080, '420 KB'],
    [5 * 1024 ** 3, '5 GB'],
    [3 * 1024 ** 5, '3072 TB'],
  ])('writes %i bytes as %s', (bytes, text) => {
    expect(formatBytes(bytes)).toBe(text);
  });
});
