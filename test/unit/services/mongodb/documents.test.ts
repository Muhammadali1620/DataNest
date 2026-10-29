import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { parseDocument, parseValue } from '../../../../src/core/mongo/shell-parse';
import { doc, int32, int64, type MongoDocument, str } from '../../../../src/core/mongo/value';
import {
  checkWrite,
  countDocuments,
  deleteDocuments,
  type DocumentQuery,
  findById,
  idOf,
  insertDocument,
  readPage,
  replaceDocument,
} from '../../../../src/services/mongodb/documents';
import { FakeMongoSession, OK } from '../../../helpers/fake-mongo';

const EMPTY = doc([]);

function query(overrides: Partial<DocumentQuery> = {}): DocumentQuery {
  return {
    filter: EMPTY,
    sort: EMPTY,
    projection: EMPTY,
    skip: 0,
    limit: 2,
    maxTimeMS: 0,
    ...overrides,
  };
}

function numbered(count: number): MongoDocument[] {
  return Array.from({ length: count }, (_, index) => doc([['_id', int32(index + 1)]]));
}

/** `{ n: …, ok: 1 }`, the reply of a write. */
function written(n: number, extra: [string, ReturnType<typeof parseValue>][] = []): MongoDocument {
  return doc([['n', int32(n)], ...extra, ['ok', { type: 'double', value: '1' }]]);
}

describe('readPage (V7.6)', () => {
  it('reads one document more than the page to know another page follows', async () => {
    const session = new FakeMongoSession();
    session.documents.set('shop.orders', numbered(5));
    let clock = 100;
    const page = await readPage(session, 'shop', 'orders', query(), () => (clock += 7));
    expect(page.documents.map((one) => one.document)).toEqual(numbered(2));
    expect(page.more).toBe(true);
    expect(page.tookMs).toBe(7);
    expect(session.cursors[0]?.request).toEqual({ kind: 'find', collection: 'orders', limit: 3 });
  });

  it('passes the parts of the query that are set, and says when the end is reached', async () => {
    const session = new FakeMongoSession();
    session.documents.set('shop.orders', numbered(5));
    const page = await readPage(
      session,
      'shop',
      'orders',
      query({
        filter: parseDocument('{ a: 1 }'),
        sort: parseDocument('{ _id: -1 }'),
        projection: parseDocument('{ a: 1 }'),
        skip: 4,
        maxTimeMS: 500,
      }),
    );
    expect(page.more).toBe(false);
    expect(page.documents).toHaveLength(1);
    expect(session.cursors[0]?.request).toEqual({
      kind: 'find',
      collection: 'orders',
      filter: parseDocument('{ a: 1 }'),
      sort: parseDocument('{ _id: -1 }'),
      projection: parseDocument('{ a: 1 }'),
      skip: 4,
      limit: 3,
      maxTimeMS: 500,
    });
  });

  it('passes a failed read on', async () => {
    const session = new FakeMongoSession();
    session.find = () => new DbError('syntax', 'unknown operator: $bad');
    await expect(readPage(session, 'shop', 'orders', query())).rejects.toThrow('$bad');
  });
});

describe('countDocuments (V7.6)', () => {
  it('asks the metadata without a filter, an estimate', async () => {
    const session = new FakeMongoSession(() =>
      doc([
        ['n', int32(250)],
        ['ok', int32(1)],
      ]),
    );
    expect(await countDocuments(session, 'shop', 'orders', EMPTY)).toEqual({
      count: '250',
      exact: false,
    });
    expect(session.commands).toEqual(['shop: { count: "orders" }']);
  });

  it('counts what a filter matches within a time, exactly, past 2^53 as text', async () => {
    const session = new FakeMongoSession();
    session.aggregate = () => [doc([['n', int64('9007199254740993')]])];
    expect(await countDocuments(session, 'shop', 'orders', parseDocument('{ a: 1 }'))).toEqual({
      count: '9007199254740993',
      exact: true,
    });
    expect(session.cursors[0]?.request).toMatchObject({
      kind: 'aggregate',
      collection: 'orders',
      maxTimeMS: 3000,
    });
    session.aggregate = () => [];
    expect(
      (await countDocuments(session, 'shop', 'orders', parseDocument('{ a: 2 }'), 0)).count,
    ).toBe('0');
    expect(session.cursors[1]?.request).not.toHaveProperty('maxTimeMS');
  });
});

describe('findById and idOf (V7.6)', () => {
  it('reads the stored document by its _id', async () => {
    const session = new FakeMongoSession();
    session.find = (request) =>
      request.kind === 'find' && request.filter !== undefined ? numbered(1) : [];
    expect(await findById(session, 'shop', 'orders', int32(1))).toEqual(numbered(1)[0]);
    expect(session.cursors[0]?.request).toEqual({
      kind: 'find',
      collection: 'orders',
      filter: doc([['_id', int32(1)]]),
      limit: 1,
    });
    session.find = () => [];
    expect(await findById(session, 'shop', 'orders', int32(2))).toBeUndefined();
  });

  it('finds the _id of a document, or none', () => {
    expect(
      idOf(
        doc([
          ['a', int32(1)],
          ['_id', str('x')],
        ]),
      ),
    ).toEqual(str('x'));
    expect(idOf(EMPTY)).toBeUndefined();
  });
});

describe('checkWrite (V7.6)', () => {
  it('lets a clean reply through', () => {
    expect(() => {
      checkWrite(written(1));
    }).not.toThrow();
  });

  it('turns the first write error into a DbError of its kind', () => {
    const reply = written(0, [
      ['writeErrors', parseValue('[{ index: 0, code: 11000, errmsg: "E11000 duplicate key" }]')],
    ]);
    expect(() => {
      checkWrite(reply);
    }).toThrow(expect.objectContaining({ code: 'constraint', message: 'E11000 duplicate key' }));
    const validation = written(0, [['writeErrors', parseValue('[{ code: 121 }]')]]);
    expect(() => {
      checkWrite(validation);
    }).toThrow('The server refused the write');
  });

  it('turns a write concern error into a DbError', () => {
    const reply = written(1, [
      [
        'writeConcernError',
        parseValue('{ code: 64, errmsg: "waiting for replication timed out" }'),
      ],
    ]);
    expect(() => {
      checkWrite(reply);
    }).toThrow(expect.objectContaining({ code: 'constraint', driverCode: 64 }));
  });
});

describe('replaceDocument (V7.6)', () => {
  const original = parseDocument('{ _id: 1, "12": "a", total: NumberDecimal("1.50") }');
  const next = parseDocument('{ _id: 1, "12": "b", total: NumberDecimal("1.50") }');

  it('replaces only while the stored document is still the one read, compared whole', async () => {
    const session = new FakeMongoSession(() => written(1));
    await replaceDocument(session, 'shop', 'orders', original, next);
    expect(session.commands).toEqual([
      'shop: { update: "orders", updates: [{ q: { _id: 1, $expr: { $eq: ["$$ROOT", { $literal: { _id: 1, "12": "a", total: NumberDecimal("1.50") } }] } }, u: { _id: 1, "12": "b", total: NumberDecimal("1.50") }, upsert: false, multi: false }] }',
    ]);
  });

  it('says the document changed meanwhile when it is there but different', async () => {
    const session = new FakeMongoSession(() => written(0));
    session.find = () => [original];
    await expect(replaceDocument(session, 'shop', 'orders', original, next)).rejects.toMatchObject({
      code: 'busy',
      message: expect.stringContaining('changed after it was read') as unknown,
    });
  });

  it('says the document was deleted meanwhile', async () => {
    const session = new FakeMongoSession(() => written(0));
    session.find = () => [];
    await expect(replaceDocument(session, 'shop', 'orders', original, next)).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('refuses a document without _id, and a changed _id', async () => {
    const session = new FakeMongoSession(() => written(1));
    await expect(
      replaceDocument(session, 'shop', 'orders', parseDocument('{ a: 1 }'), next),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      replaceDocument(session, 'shop', 'orders', original, parseDocument('{ _id: 2 }')),
    ).rejects.toThrow('The _id cannot change: keep _id: 1');
    await expect(
      replaceDocument(session, 'shop', 'orders', original, parseDocument('{ a: 2 }')),
    ).rejects.toMatchObject({ code: 'constraint' });
    expect(session.commands).toEqual([]);
  });

  it('passes a write error on, e.g. a validator that refuses the document', async () => {
    const session = new FakeMongoSession(() =>
      written(0, [
        ['writeErrors', parseValue('[{ code: 121, errmsg: "Document failed validation" }]')],
      ]),
    );
    await expect(replaceDocument(session, 'shop', 'orders', original, next)).rejects.toThrow(
      'Document failed validation',
    );
  });
});

describe('insertDocument (V7.6)', () => {
  it('gives a document without _id a new ObjectId, first', async () => {
    const session = new FakeMongoSession(() => written(1));
    const id = await insertDocument(session, 'shop', 'orders', parseDocument('{ a: 1 }'));
    expect(id.type).toBe('objectId');
    expect(session.commands[0]).toMatch(
      /^shop: \{ insert: "orders", documents: \[\{ _id: ObjectId\("[0-9a-f]{24}"\), a: 1 \}\] \}$/,
    );
  });

  it('keeps an _id the document has, and passes a duplicate key on', async () => {
    const session = new FakeMongoSession(() => written(1));
    expect(
      await insertDocument(session, 'shop', 'orders', parseDocument('{ a: 1, _id: "x" }')),
    ).toEqual(str('x'));
    expect(session.commands).toEqual([
      'shop: { insert: "orders", documents: [{ a: 1, _id: "x" }] }',
    ]);
    const duplicate = new FakeMongoSession(() =>
      written(0, [['writeErrors', parseValue('[{ code: 11000, errmsg: "E11000" }]')]]),
    );
    await expect(
      insertDocument(duplicate, 'shop', 'orders', parseDocument('{ _id: 1 }')),
    ).rejects.toMatchObject({ code: 'constraint' });
  });
});

describe('deleteDocuments (V7.6)', () => {
  it('deletes each document by its _id, one at most', async () => {
    const session = new FakeMongoSession(() => written(2));
    expect(await deleteDocuments(session, 'shop', 'orders', [int32(1), str('b')])).toBe(2);
    expect(session.commands).toEqual([
      'shop: { delete: "orders", deletes: [{ q: { _id: 1 }, limit: 1 }, { q: { _id: "b" }, limit: 1 }] }',
    ]);
  });

  it('sends nothing for no documents', async () => {
    const session = new FakeMongoSession(() => OK);
    expect(await deleteDocuments(session, 'shop', 'orders', [])).toBe(0);
    expect(session.commands).toEqual([]);
  });

  it('passes a refusal on, e.g. a capped collection', async () => {
    const session = new FakeMongoSession(() =>
      written(0, [
        [
          'writeErrors',
          parseValue('[{ code: 20, errmsg: "cannot remove from a capped collection" }]'),
        ],
      ]),
    );
    await expect(deleteDocuments(session, 'shop', 'events', [int32(1)])).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
