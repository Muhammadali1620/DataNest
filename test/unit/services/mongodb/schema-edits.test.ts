import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { parseDocument } from '../../../../src/core/mongo/shell-parse';
import {
  collectionNameProblem,
  createCollection,
  createDatabase,
  createIndex,
  createIndexCommand,
  databaseNameProblem,
  defaultIndexName,
  dropCollection,
  dropDatabase,
  dropIndex,
  indexKeyProblem,
  renameCollection,
} from '../../../../src/services/mongodb/schema-edits';
import { FakeMongoSession } from '../../../helpers/fake-mongo';

describe('names (V7.5)', () => {
  it('refuses database names MongoDB refuses', () => {
    expect(databaseNameProblem('shop_2026')).toBeUndefined();
    for (const name of ['', ' ', 'a.b', 'a b', 'a/b', 'a$', 'a"b', 'a\u0000']) {
      expect(databaseNameProblem(name)).toBeDefined();
    }
    expect(databaseNameProblem('x'.repeat(64))).toContain('63 bytes');
    expect(databaseNameProblem('ж'.repeat(32))).toContain('63 bytes');
  });

  it('refuses collection names MongoDB refuses', () => {
    expect(collectionNameProblem('orders.archive')).toBeUndefined();
    expect(collectionNameProblem('')).toBe('The name is empty');
    expect(collectionNameProblem('a$b')).toContain('$');
    expect(collectionNameProblem('system.x')).toContain('system.');
    expect(collectionNameProblem('.a')).toContain('dot');
    expect(collectionNameProblem('a.')).toContain('dot');
  });
});

describe('collections and databases (V7.5)', () => {
  it('creates a plain, capped or time series collection with one command', async () => {
    const session = new FakeMongoSession();
    await createCollection(session, 'shop', 'orders');
    await createCollection(session, 'shop', 'log', {
      kind: 'capped',
      sizeBytes: 1024,
      maxDocuments: 10,
    });
    await createCollection(session, 'shop', 'metrics', {
      kind: 'timeseries',
      timeField: 'at',
      metaField: 'sensor',
    });
    await createCollection(session, 'shop', 'm2', { kind: 'timeseries', timeField: 'at' });
    expect(session.commands).toEqual([
      'shop: { create: "orders" }',
      'shop: { create: "log", capped: true, size: NumberLong("1024"), max: NumberLong("10") }',
      'shop: { create: "metrics", timeseries: { timeField: "at", metaField: "sensor" } }',
      'shop: { create: "m2", timeseries: { timeField: "at" } }',
    ]);
  });

  it('refuses a bad name before it reaches the server', async () => {
    const session = new FakeMongoSession();
    await expect(createCollection(session, 'shop', 'a$')).rejects.toBeInstanceOf(DbError);
    await expect(createDatabase(session, 'a b', 'x')).rejects.toMatchObject({ code: 'syntax' });
    expect(session.commands).toEqual([]);
  });

  it('creates a database with its first collection, and drops one', async () => {
    const session = new FakeMongoSession();
    await createDatabase(session, 'new_db', 'first');
    await dropDatabase(session, 'new_db');
    expect(session.commands).toEqual([
      'new_db: { create: "first" }',
      'new_db: { dropDatabase: 1 }',
    ]);
  });

  it('renames within the database without replacing a target, and drops', async () => {
    const session = new FakeMongoSession();
    await renameCollection(session, 'shop', 'orders', 'orders_old');
    await dropCollection(session, 'shop', 'big_orders');
    expect(session.commands).toEqual([
      'admin: { renameCollection: "shop.orders", to: "shop.orders_old", dropTarget: false }',
      'shop: { drop: "big_orders" }',
    ]);
    await expect(renameCollection(session, 'shop', 'a', 'system.b')).rejects.toMatchObject({
      code: 'syntax',
    });
  });

  it("passes the server's refusal on", async () => {
    const session = new FakeMongoSession(
      () => new DbError('constraint', 'Collection already exists'),
    );
    await expect(createCollection(session, 'shop', 'orders')).rejects.toThrow('already exists');
  });
});

describe('indexes (V7.5)', () => {
  it('names an index the way the server does', () => {
    expect(defaultIndexName(parseDocument('{ email: 1, name: -1 }'))).toBe('email_1_name_-1');
    expect(defaultIndexName(parseDocument('{ location: "2dsphere" }'))).toBe('location_2dsphere');
    expect(defaultIndexName(parseDocument('{ a: NumberLong(1), b: -1.0 }'))).toBe('a_1_b_-1');
  });

  it('refuses keys that are neither a direction nor a kind', () => {
    expect(indexKeyProblem(parseDocument('{}'))).toContain('no keys');
    expect(indexKeyProblem(parseDocument('{ a: true }'))).toContain('"a"');
    expect(indexKeyProblem(parseDocument('{ a: 1, b: "text" }'))).toBeUndefined();
  });

  it('builds createIndexes with a name and the options as given', async () => {
    const session = new FakeMongoSession();
    await createIndex(
      session,
      'shop',
      'users',
      parseDocument('{ email: 1 }'),
      parseDocument('{ unique: true }'),
    );
    expect(session.commands).toEqual([
      'shop: { createIndexes: "users", indexes: [{ key: { email: 1 }, name: "email_1", unique: true }] }',
    ]);
  });

  it('keeps a name the user gives, and ignores a key in the options', async () => {
    const session = new FakeMongoSession();
    await createIndex(
      session,
      'shop',
      'users',
      parseDocument('{ a: 1 }'),
      parseDocument('{ name: "mine", key: { b: 1 } }'),
    );
    expect(session.commands).toEqual([
      'shop: { createIndexes: "users", indexes: [{ key: { a: 1 }, name: "mine" }] }',
    ]);
    expect(() => createIndexCommand('u', parseDocument('{}'), parseDocument(''))).toThrow(
      'no keys',
    );
  });

  it('drops an index by name, but never _id_', async () => {
    const session = new FakeMongoSession();
    await dropIndex(session, 'shop', 'users', 'email_1');
    expect(session.commands).toEqual(['shop: { dropIndexes: "users", index: "email_1" }']);
    await expect(dropIndex(session, 'shop', 'users', '_id_')).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
