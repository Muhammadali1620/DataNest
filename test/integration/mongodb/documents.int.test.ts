import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { formatPretty, formatValue } from '../../../src/core/mongo/shell-format';
import { parseDocument, parseValue } from '../../../src/core/mongo/shell-parse';
import { doc, int32, sameValue, str } from '../../../src/core/mongo/value';
import { driver } from '../../../src/drivers/mongodb';
import type { MongoSession } from '../../../src/drivers/mongo-driver';
import {
  countDocuments,
  deleteDocuments,
  findById,
  insertDocument,
  readPage,
  replaceDocument,
} from '../../../src/services/mongodb/documents';
import { MongoDocumentsModel } from '../../../src/vscode/panels/mongo-documents-model';
import { TEST_MONGO } from '../../helpers/mongo-servers';

// docker/compose.yml `mongodb` (V7.6): reading and changing documents on a real server.
const SCRATCH = 'datanest_it_documents';
let session: MongoSession;
let other: MongoSession;

async function open(
  user: { readonly name: string; readonly password: string } = TEST_MONGO.user,
): Promise<MongoSession> {
  return await driver.openSession({
    id: 'it',
    name: 'it',
    driver: 'mongodb',
    host: TEST_MONGO.host,
    port: TEST_MONGO.port,
    user: user.name,
    password: user.password,
  });
}

const EMPTY = doc([]);

beforeAll(async () => {
  session = await open();
  // Another client, as when someone else changes a document meanwhile.
  other = await open();
});

afterAll(async () => {
  await session.command(SCRATCH, doc([['dropDatabase', int32(1)]]));
  await session.close();
  await other.close();
});

beforeEach(async () => {
  await session.command(SCRATCH, doc([['dropDatabase', int32(1)]]));
  await session.command(
    SCRATCH,
    doc([
      ['insert', str('items')],
      [
        'documents',
        parseValue(`[
          { _id: 1, "12": "numeric first", name: "a", price: NumberDecimal("1.50"), qty: 2.0, big: NumberLong("9007199254740993") },
          { _id: 2, name: "b" },
          { _id: 3, name: "c" }
        ]`),
      ],
    ]),
  );
});

describe('reading documents (V7.6)', () => {
  it('reads pages of the seed with a filter, a sort, a projection and a skip', async () => {
    const first = await readPage(session, 'shop', 'orders', {
      filter: parseDocument('{ status: "shipped" }'),
      sort: parseDocument('{ _id: -1 }'),
      projection: parseDocument('{ status: 1 }'),
      skip: 0,
      limit: 50,
      maxTimeMS: 5000,
    });
    expect(first.documents).toHaveLength(50);
    expect(first.more).toBe(true);
    expect(formatValue(first.documents[0]?.document ?? EMPTY)).toBe(
      '{ _id: 248, status: "shipped" }',
    );
    const last = await readPage(session, 'shop', 'orders', {
      filter: parseDocument('{ status: "shipped" }'),
      sort: parseDocument('{ _id: -1 }'),
      projection: EMPTY,
      skip: 50,
      limit: 50,
      maxTimeMS: 0,
    });
    expect(last.documents).toHaveLength(12);
    expect(last.more).toBe(false);
  });

  it('counts a whole collection from its metadata and a filter exactly', async () => {
    expect(await countDocuments(session, 'shop', 'orders', EMPTY)).toEqual({
      count: '250',
      exact: false,
    });
    expect(
      await countDocuments(session, 'shop', 'orders', parseDocument('{ status: "new" }')),
    ).toEqual({
      count: '188',
      exact: true,
    });
    expect(
      await countDocuments(session, 'shop', 'orders', parseDocument('{ status: "none" }')),
    ).toEqual({
      count: '0',
      exact: true,
    });
    expect((await countDocuments(session, 'shop', 'big_orders', EMPTY)).count).toBe('50');
  });

  it('reads a view, and refuses a filter the server does not know', async () => {
    const view = await readPage(session, 'shop', 'big_orders', {
      filter: EMPTY,
      sort: parseDocument('{ _id: 1 }'),
      projection: EMPTY,
      skip: 0,
      limit: 3,
      maxTimeMS: 0,
    });
    expect(view.documents).toHaveLength(3);
    await expect(
      readPage(session, 'shop', 'orders', {
        filter: parseDocument('{ $bad: 1 }'),
        sort: EMPTY,
        projection: EMPTY,
        skip: 0,
        limit: 3,
        maxTimeMS: 0,
      }),
    ).rejects.toMatchObject({ code: 'syntax' });
  });
});

describe('changing documents (V7.6)', () => {
  it('replaces a document keeping field order and every type it did not touch', async () => {
    const original = await findById(session, SCRATCH, 'items', int32(1));
    if (original === undefined) {
      throw new Error('missing');
    }
    const edited = parseDocument(formatPretty(original).replace('name: "a"', 'name: "renamed"'));
    await replaceDocument(session, SCRATCH, 'items', original, edited);
    const stored = await findById(session, SCRATCH, 'items', int32(1));
    expect(stored === undefined ? false : sameValue(stored, edited)).toBe(true);
    expect(formatValue(stored ?? EMPTY)).toBe(
      '{ _id: 1, "12": "numeric first", name: "renamed", price: NumberDecimal("1.50"), qty: 2.0, big: NumberLong("9007199254740993") }',
    );
  });

  it('refuses to overwrite what another client changed meanwhile', async () => {
    const original = await findById(session, SCRATCH, 'items', int32(2));
    if (original === undefined) {
      throw new Error('missing');
    }
    await other.command(
      SCRATCH,
      doc([
        ['update', str('items')],
        ['updates', parseValue('[{ q: { _id: 2 }, u: { $set: { name: "theirs" } } }]')],
      ]),
    );
    await expect(
      replaceDocument(
        session,
        SCRATCH,
        'items',
        original,
        parseDocument('{ _id: 2, name: "mine" }'),
      ),
    ).rejects.toMatchObject({ code: 'busy' });
    expect(formatValue((await findById(session, SCRATCH, 'items', int32(2))) ?? EMPTY)).toBe(
      '{ _id: 2, name: "theirs" }',
    );
    await other.command(
      SCRATCH,
      doc([
        ['delete', str('items')],
        ['deletes', parseValue('[{ q: { _id: 2 }, limit: 1 }]')],
      ]),
    );
    await expect(
      replaceDocument(
        session,
        SCRATCH,
        'items',
        original,
        parseDocument('{ _id: 2, name: "mine" }'),
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('a different field order counts as a change', async () => {
    const reordered = parseDocument('{ name: "c", _id: 3 }');
    await expect(
      replaceDocument(session, SCRATCH, 'items', reordered, parseDocument('{ _id: 3, name: "x" }')),
    ).rejects.toMatchObject({ code: 'busy' });
  });

  it('inserts with a new ObjectId, refuses a duplicate _id, and deletes by _id', async () => {
    const id = await insertDocument(session, SCRATCH, 'items', parseDocument('{ name: "new" }'));
    expect(id.type).toBe('objectId');
    expect(await findById(session, SCRATCH, 'items', id)).toBeDefined();
    await expect(
      insertDocument(session, SCRATCH, 'items', parseDocument('{ _id: 1 }')),
    ).rejects.toMatchObject({ code: 'constraint' });
    expect(await deleteDocuments(session, SCRATCH, 'items', [id, int32(3), int32(99)])).toBe(2);
    expect(
      (await countDocuments(session, SCRATCH, 'items', parseDocument('{ _id: { $gt: 0 } }'))).count,
    ).toBe('2');
  });

  it('refuses a read-only user every change', async () => {
    const reader = await open(TEST_MONGO.reader);
    try {
      await expect(
        insertDocument(reader, SCRATCH, 'items', parseDocument('{ a: 1 }')),
      ).rejects.toMatchObject({ code: 'permission-denied' });
      await expect(deleteDocuments(reader, SCRATCH, 'items', [int32(1)])).rejects.toMatchObject({
        code: 'permission-denied',
      });
    } finally {
      await reader.close();
    }
  });
});

describe('the documents page model on a server (V7.6)', () => {
  it('reads, edits through a projection and deletes', async () => {
    const model = new MongoDocumentsModel({
      connectionName: 'it',
      database: SCRATCH,
      collection: 'items',
      collectionType: 'collection',
      readOnly: false,
      session: () => Promise.resolve(session),
      maxTimeMS: () => 5000,
    });
    const state = await model.run({
      filter: '',
      sort: '{ _id: 1 }',
      projection: '{ name: 1 }',
      limit: 2,
    });
    expect(state.columns).toEqual(['_id', 'name']);
    expect(state.more).toBe(true);
    expect(state.total).toEqual({ count: '3', exact: false });
    const opened = await model.edit(0);
    expect(opened.text).toContain('price: NumberDecimal("1.50")');
    expect(
      await model.save(opened.token, opened.text.replace('name: "a"', 'name: "edited"')),
    ).toEqual({});
    expect(formatValue((await findById(session, SCRATCH, 'items', int32(1))) ?? EMPTY)).toContain(
      'name: "edited", price: NumberDecimal("1.50")',
    );
    expect(await model.delete([1])).toBe(1);
    expect((await model.refresh()).rows.map((row) => row.id)).toEqual(['1', '3']);
  });
});
