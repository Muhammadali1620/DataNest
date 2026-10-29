import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { parseShellStatement } from '../../../../src/core/mongo/shell-command';
import { formatValue } from '../../../../src/core/mongo/shell-format';
import { parseValue } from '../../../../src/core/mongo/shell-parse';
import { doc, int32, type MongoDocument, str } from '../../../../src/core/mongo/value';
import {
  type RunOutcome,
  runStatement,
  statementEffect,
} from '../../../../src/services/mongodb/shell-run';
import { collection, FakeMongoSession, indexSpec } from '../../../helpers/fake-mongo';

function effect(text: string): string {
  return statementEffect(parseShellStatement(text));
}

function reply(text: string): MongoDocument {
  const value = parseValue(text);
  if (value.type !== 'document') {
    throw new Error('not a document');
  }
  return value;
}

async function run(session: FakeMongoSession, text: string, maxTimeMS = 0): Promise<RunOutcome> {
  return await runStatement(session, 'shop', parseShellStatement(text), { maxTimeMS });
}

describe('statementEffect (V7.7)', () => {
  it.each([
    'use other',
    'show dbs',
    'db.orders.find({})',
    'db.orders.findOne()',
    'db.orders.aggregate([{ $match: {} }])',
    'db.orders.aggregate([{ $out: "copy" }]).explain()',
    'db.orders.countDocuments({})',
    'db.orders.estimatedDocumentCount()',
    'db.orders.distinct("a")',
    'db.orders.getIndexes()',
    'db.orders.stats()',
    'db.getCollectionNames()',
    'db.runCommand({ ping: 1 })',
    'db.runCommand({ aggregate: "orders", pipeline: [], cursor: {} })',
    'db.adminCommand({ listDatabases: 1 })',
    'db.runCommand({ serverStatus: 1 })',
  ])('reads: %s', (text) => {
    expect(effect(text)).toBe('read');
  });

  it.each([
    'db.orders.insertOne({ a: 1 })',
    'db.orders.insertMany([{ a: 1 }])',
    'db.orders.updateOne({ a: 1 }, { $set: { b: 1 } })',
    'db.orders.updateMany({ a: 1 }, { $set: { b: 1 } })',
    'db.orders.replaceOne({ a: 1 }, { b: 1 })',
    'db.orders.deleteOne({})',
    'db.orders.deleteMany({ a: 1 })',
    'db.orders.createIndex({ a: 1 })',
    'db.orders.dropIndex("a_1")',
    'db.createCollection("x")',
    'db.orders.aggregate([{ $merge: "copy" }])',
    'db.orders.aggregate([{ $match: {} }, { $out: "copy" }])',
    'db.runCommand({ insert: "orders", documents: [] })',
    'db.runCommand({ aggregate: "orders", pipeline: [{ $out: "x" }], cursor: {} })',
    'db.runCommand({ someNewCommand: 1 })',
    'db.runCommand(1)',
    'db.orders.bulkWrite([])',
  ])('writes: %s', (text) => {
    expect(effect(text)).toBe('write');
  });

  it.each([
    'db.orders.drop()',
    'db.dropDatabase()',
    'db.orders.deleteMany({})',
    'db.orders.deleteMany()',
    'db.orders.updateMany({}, { $set: { a: 1 } })',
    'db.runCommand({ drop: "orders" })',
    'db.adminCommand({ shutdown: 1 })',
    'db.runCommand({ dropDatabase: 1 })',
  ])('writes something hard to undo: %s', (text) => {
    expect(effect(text)).toBe('dangerous');
  });
});

describe('runStatement: reading (V7.7)', () => {
  it('opens a cursor for a find with its chain', async () => {
    const session = new FakeMongoSession();
    const outcome = await run(
      session,
      'db.orders.find({ a: 1 }, { b: 1 }).sort({ c: -1 }).skip(5).limit(10).hint("c_-1").collation({ locale: "en" }).maxTimeMS(9).toArray()',
      100,
    );
    expect(outcome).toMatchObject({ kind: 'cursor', collection: 'orders' });
    expect(session.cursors[0]).toEqual({
      database: 'shop',
      request: {
        kind: 'find',
        collection: 'orders',
        filter: reply('{ a: 1 }'),
        projection: reply('{ b: 1 }'),
        sort: reply('{ c: -1 }'),
        skip: 5,
        limit: 10,
        hint: str('c_-1'),
        collation: reply('{ locale: "en" }'),
        maxTimeMS: 9,
      },
    });
  });

  it('runs a pipeline on a collection or on the database', async () => {
    const session = new FakeMongoSession();
    await run(session, 'db.orders.aggregate([{ $match: {} }], { allowDiskUse: true })', 50);
    await run(session, 'db.aggregate([{ $documents: [{ a: 1 }] }])');
    expect(session.cursors.map((one) => one.request)).toEqual([
      {
        kind: 'aggregate',
        collection: 'orders',
        pipeline: [reply('{ $match: {} }')],
        maxTimeMS: 50,
        allowDiskUse: true,
      },
      { kind: 'aggregate', pipeline: [reply('{ $documents: [{ a: 1 }] }')] },
    ]);
  });

  it('reads one document with findOne', async () => {
    const session = new FakeMongoSession();
    session.documents.set('shop.orders', [reply('{ _id: 1 }'), reply('{ _id: 2 }')]);
    expect(await run(session, 'db.orders.findOne({})')).toEqual({
      kind: 'documents',
      documents: [reply('{ _id: 1 }')],
    });
  });

  it('counts with a filter, without one, and through .count()', async () => {
    const session = new FakeMongoSession(() => reply('{ n: 250, ok: 1 }'));
    session.aggregate = () => [reply('{ n: 7 }')];
    expect(await run(session, 'db.orders.countDocuments({ a: 1 })')).toEqual({
      kind: 'count',
      count: '7',
    });
    expect(await run(session, 'db.orders.count()')).toEqual({ kind: 'count', count: '250' });
    expect(await run(session, 'db.orders.estimatedDocumentCount()')).toEqual({
      kind: 'count',
      count: '250',
    });
    expect(await run(session, 'db.orders.find({ a: 1 }).count()')).toEqual({
      kind: 'count',
      count: '7',
    });
  });

  it('turns distinct values into documents', async () => {
    const session = new FakeMongoSession(() => reply('{ values: ["a", 2], ok: 1 }'));
    expect(await run(session, 'db.orders.distinct("city", { a: 1 })')).toEqual({
      kind: 'documents',
      documents: [doc([['value', str('a')]]), doc([['value', int32(2)]])],
    });
    expect(session.commands).toEqual([
      'shop: { distinct: "orders", key: "city", query: { a: 1 } }',
    ]);
  });

  it('runs commands, explains and lists', async () => {
    const session = new FakeMongoSession(() => reply('{ ok: 1 }'));
    session.collections.set('shop', [collection('b'), collection('a', 'view')]);
    session.indexes.set('shop.orders', [indexSpec('_id_', reply('{ _id: 1 }'))]);
    session.databases = [{ name: 'shop', sizeOnDisk: 5 }, { name: 'logs' }];
    await run(session, 'db.runCommand({ ping: 1 })');
    await run(session, 'db.adminCommand({ listDatabases: 1 })');
    await run(session, 'db.stats()');
    await run(session, 'db.orders.stats()');
    await run(session, 'db.orders.find({ a: 1 }).sort({ b: 1 }).limit(2).explain()');
    await run(session, 'db.orders.aggregate([{ $match: {} }]).explain()');
    await run(session, 'db.aggregate([]).explain()');
    expect(session.commands).toEqual([
      'shop: { ping: 1 }',
      'admin: { listDatabases: 1 }',
      'shop: { dbStats: 1 }',
      'shop: { collStats: "orders" }',
      'shop: { explain: { find: "orders", filter: { a: 1 }, sort: { b: 1 }, limit: 2 }, verbosity: "queryPlanner" }',
      'shop: { explain: { aggregate: "orders", pipeline: [{ $match: {} }], cursor: {} }, verbosity: "queryPlanner" }',
      'shop: { explain: { aggregate: 1, pipeline: [], cursor: {} }, verbosity: "queryPlanner" }',
    ]);
    const names = await run(session, 'db.getCollectionNames()');
    expect(names.kind === 'documents' && names.documents.map((one) => formatValue(one))).toEqual([
      '{ name: "a" }',
      '{ name: "b" }',
    ]);
    const shown = await run(session, 'show collections');
    expect(shown.kind === 'documents' && shown.documents.map((one) => formatValue(one))).toEqual([
      '{ name: "a", type: "view" }',
      '{ name: "b", type: "collection" }',
    ]);
    const dbs = await run(session, 'show dbs');
    expect(dbs.kind === 'documents' && dbs.documents.map((one) => formatValue(one))).toEqual([
      '{ name: "shop", sizeOnDisk: NumberLong("5") }',
      '{ name: "logs" }',
    ]);
    const indexes = await run(session, 'db.orders.getIndexes()');
    expect(indexes.kind === 'documents' && indexes.documents).toHaveLength(1);
  });

  it('runs in the database getSiblingDB names, and passes use back', async () => {
    const session = new FakeMongoSession();
    await run(session, 'db.getSiblingDB("logs").events.find()');
    expect(session.cursors[0]?.database).toBe('logs');
    expect(await run(session, 'use other')).toEqual({ kind: 'use', database: 'other' });
  });
});

describe('runStatement: writing (V7.7)', () => {
  it('inserts one or many documents and says how many', async () => {
    const session = new FakeMongoSession(() => reply('{ n: 2, ok: 1 }'));
    expect(await run(session, 'db.orders.insertMany([{ a: 1 }, { a: 2 }])')).toMatchObject({
      kind: 'write',
      inserted: 2,
    });
    await run(session, 'db.orders.insertOne({ a: 1 })');
    expect(session.commands).toEqual([
      'shop: { insert: "orders", documents: [{ a: 1 }, { a: 2 }] }',
      'shop: { insert: "orders", documents: [{ a: 1 }] }',
    ]);
  });

  it('updates with operators or a pipeline, and replaces with a whole document', async () => {
    const session = new FakeMongoSession(() => reply('{ n: 3, nModified: 2, ok: 1 }'));
    expect(
      await run(
        session,
        'db.orders.updateMany({ a: 1 }, { $set: { b: 2 } }, { upsert: true, arrayFilters: [] })',
      ),
    ).toMatchObject({ kind: 'write', matched: 3, modified: 2, upserted: 0 });
    await run(session, 'db.orders.updateOne({ a: 1 }, [{ $set: { b: "$a" } }])');
    await run(session, 'db.orders.replaceOne({ _id: 1 }, { b: 1 })');
    expect(session.commands).toEqual([
      'shop: { update: "orders", updates: [{ q: { a: 1 }, u: { $set: { b: 2 } }, upsert: true, multi: true, arrayFilters: [] }] }',
      'shop: { update: "orders", updates: [{ q: { a: 1 }, u: [{ $set: { b: "$a" } }], upsert: false, multi: false }] }',
      'shop: { update: "orders", updates: [{ q: { _id: 1 }, u: { b: 1 }, upsert: false, multi: false }] }',
    ]);
  });

  it('counts an upsert apart from what matched', async () => {
    const session = new FakeMongoSession(() =>
      reply(
        '{ n: 1, nModified: 0, upserted: [{ index: 0, _id: ObjectId("65a1b2c3d4e5f60718293a4b") }], ok: 1 }',
      ),
    );
    expect(
      await run(session, 'db.orders.updateOne({ a: 9 }, { $set: { b: 1 } }, { upsert: true })'),
    ).toMatchObject({
      matched: 0,
      modified: 0,
      upserted: 1,
    });
  });

  it('refuses an update without operators and a replacement with them', async () => {
    const session = new FakeMongoSession();
    await expect(run(session, 'db.orders.updateOne({}, { b: 1 })')).rejects.toThrow(
      'needs update operators',
    );
    await expect(run(session, 'db.orders.replaceOne({}, { $set: { b: 1 } })')).rejects.toThrow(
      'takes a whole document',
    );
    await expect(run(session, 'db.orders.updateOne({}, 5)')).rejects.toThrow(
      'as a document or a pipeline',
    );
    expect(session.commands).toEqual([]);
  });

  it('deletes one or every matching document', async () => {
    const session = new FakeMongoSession(() => reply('{ n: 4, ok: 1 }'));
    expect(await run(session, 'db.orders.deleteMany({ a: 1 })')).toMatchObject({
      kind: 'write',
      deleted: 4,
    });
    await run(session, 'db.orders.deleteOne({ a: 1 })');
    expect(session.commands).toEqual([
      'shop: { delete: "orders", deletes: [{ q: { a: 1 }, limit: 0 }] }',
      'shop: { delete: "orders", deletes: [{ q: { a: 1 }, limit: 1 }] }',
    ]);
  });

  it('manages indexes and collections', async () => {
    const session = new FakeMongoSession(() => reply('{ ok: 1 }'));
    await run(session, 'db.orders.createIndex({ a: 1 }, { unique: true })');
    await run(session, 'db.orders.dropIndex("a_1")');
    await run(session, 'db.orders.drop()');
    await run(session, 'db.createCollection("log", { capped: true, size: 1024 })');
    await run(session, 'db.dropDatabase()');
    expect(session.commands).toEqual([
      'shop: { createIndexes: "orders", indexes: [{ key: { a: 1 }, name: "a_1", unique: true }] }',
      'shop: { dropIndexes: "orders", index: "a_1" }',
      'shop: { drop: "orders" }',
      'shop: { create: "log", capped: true, size: 1024 }',
      'shop: { dropDatabase: 1 }',
    ]);
  });

  it('passes a write error on', async () => {
    const session = new FakeMongoSession(() =>
      reply(
        '{ n: 0, writeErrors: [{ index: 0, code: 11000, errmsg: "E11000 duplicate key" }], ok: 1 }',
      ),
    );
    await expect(run(session, 'db.orders.insertOne({ _id: 1 })')).rejects.toMatchObject({
      code: 'constraint',
      message: 'E11000 duplicate key',
    });
  });
});

describe('runStatement: what it refuses (V7.7)', () => {
  it.each([
    ['db.orders.findOneAndUpdate({}, {})', 'does not run findOneAndUpdate()'],
    ['db.version()', 'does not run db.version()'],
    ['db.orders.find().forEach()', 'does not run .forEach() after find()'],
    ['db.orders.find().limit(-1)', 'limit() expects a whole number'],
    ['db.orders.find().limit("5")', 'limit() expects a whole number'],
    ['db.orders.find(5)', 'find() expects the filter as a document'],
    ['db.orders.find().hint()', 'hint() expects an index name or keys'],
    ['db.orders.find().sort()', 'sort() expects the sort as a document'],
    ['db.orders.aggregate({ $match: {} })', 'aggregate() expects the stages in brackets'],
    ['db.orders.insertOne()', 'insertOne() expects the document as a document'],
    ['db.orders.insertMany([])', 'insertMany() expects documents'],
    ['db.orders.insertMany([1])', 'insertMany() expects documents'],
    ['db.orders.distinct(1)', 'distinct() expects the field name in quotes'],
    ['db.orders.deleteMany(5)', 'deleteMany() expects the filter as a document'],
    ['db.orders.dropIndex()', 'dropIndex() expects the name or the keys'],
    ['db.createCollection(1)', 'createCollection() expects a name in quotes'],
    ['db.runCommand()', 'runCommand() expects the command as a document'],
  ])('refuses %s', async (text, message) => {
    const session = new FakeMongoSession();
    await expect(run(session, text)).rejects.toThrow(message);
    await expect(run(session, text)).rejects.toBeInstanceOf(DbError);
  });
});
