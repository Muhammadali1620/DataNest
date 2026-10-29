import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { formatValue } from '../../../../src/core/mongo/shell-format';
import { parseDocument } from '../../../../src/core/mongo/shell-parse';
import { doc, int32, type MongoDocument } from '../../../../src/core/mongo/value';
import { mongoDocumentsProtocol } from '../../../../src/shared/protocols/mongo-documents';
import {
  MongoDocumentsModel,
  type MongoDocumentsModelDeps,
} from '../../../../src/vscode/panels/mongo-documents-model';
import { FakeMongoSession } from '../../../helpers/fake-mongo';

function reply(n: number): MongoDocument {
  return doc([
    ['n', int32(n)],
    ['ok', int32(1)],
  ]);
}

function setup(overrides: Partial<MongoDocumentsModelDeps> = {}) {
  const writes: string[] = [];
  let n = 1;
  const session = new FakeMongoSession((_database, command) => {
    const name = command.fields[0]?.[0];
    if (name === 'count') {
      return reply(3);
    }
    writes.push(formatValue(command));
    return reply(n);
  });
  session.documents.set('shop.orders', [
    parseDocument('{ _id: 1, status: "new" }'),
    parseDocument('{ _id: 2, status: "shipped", items: 3 }'),
    parseDocument('{ _id: 3, status: "new" }'),
  ]);
  const model = new MongoDocumentsModel({
    connectionName: 'Shop',
    database: 'shop',
    collection: 'orders',
    collectionType: 'collection',
    readOnly: false,
    session: () => Promise.resolve(session),
    maxTimeMS: () => 0,
    now: () => 0,
    ...overrides,
  });
  return {
    model,
    session,
    writes,
    setN: (value: number) => {
      n = value;
    },
  };
}

const QUERY = { filter: '', sort: '', projection: '', limit: 2 };

describe('MongoDocumentsModel: reading (V7.6)', () => {
  it('reads the first page with the count, in a state the protocol accepts', async () => {
    const { model } = setup();
    const state = await model.run(QUERY);
    expect(mongoDocumentsProtocol.webview.events.state.parse(state)).toEqual(state);
    expect(state).toMatchObject({
      connectionName: 'Shop',
      database: 'shop',
      collection: 'orders',
      editable: true,
      insertable: true,
      skip: 0,
      columns: ['_id', 'status', 'items'],
      more: true,
      total: { count: '3', exact: false },
    });
    expect(state.rows.map((row) => row.id)).toEqual(['1', '2']);
    expect(state.error).toBeUndefined();
  });

  it('pages on with the same query, never before the first document', async () => {
    const { model } = setup();
    await model.run(QUERY);
    const second = await model.page(2);
    expect(second.skip).toBe(2);
    expect(second.rows.map((row) => row.id)).toEqual(['3']);
    expect(second.more).toBe(false);
    expect((await model.page(-5)).skip).toBe(0);
  });

  it('points at the box a typed query is wrong in, keeping the page', async () => {
    const { model, session } = setup();
    await model.run(QUERY);
    const state = await model.run({ ...QUERY, sort: '{ a: 1,\n  b }' });
    expect(state.error).toEqual({
      message: expect.stringContaining('Expected ":"') as unknown,
      box: 'sort',
      line: 2,
      column: 5,
    });
    expect(state.rows).toHaveLength(2);
    expect(session.cursors).toHaveLength(1);
  });

  it('sends the parsed query to the server and counts what the filter matches', async () => {
    const { model, session } = setup({ maxTimeMS: () => 1500 });
    session.aggregate = () => [doc([['n', int32(2)]])];
    const state = await model.run({
      filter: '{ status: "new" }',
      sort: '{ _id: -1 }',
      projection: '{ status: 1 }',
      limit: 20,
    });
    expect(session.cursors[0]?.request).toMatchObject({
      filter: parseDocument('{ status: "new" }'),
      sort: parseDocument('{ _id: -1 }'),
      projection: parseDocument('{ status: 1 }'),
      limit: 21,
      maxTimeMS: 1500,
    });
    expect(state.total).toEqual({ count: '2', exact: true });
    expect(state.query.filter).toBe('{ status: "new" }');
  });

  it('leaves the count unknown when it takes too long, and counts on request', async () => {
    const { model, session } = setup();
    session.aggregate = () => new DbError('timeout', 'operation exceeded time limit');
    const state = await model.run({ ...QUERY, filter: '{ a: 1 }' });
    expect(state.total).toBeUndefined();
    session.aggregate = () => [doc([['n', int32(9)]])];
    expect((await model.count()).total).toEqual({ count: '9', exact: true });
  });

  it('shows a failed read as an error of the query and keeps the documents', async () => {
    const { model, session } = setup();
    await model.run(QUERY);
    session.find = () => new DbError('syntax', 'unknown top level operator: $bad');
    const state = await model.refresh();
    expect(state.error).toEqual({ message: 'unknown top level operator: $bad', box: 'filter' });
    expect(state.rows).toHaveLength(2);
  });

  it('passes a lost link on, so the manager reconnects', async () => {
    const { model, session } = setup();
    session.find = () => new DbError('connection-failed', 'socket closed');
    await expect(model.refresh()).rejects.toMatchObject({ code: 'connection-failed' });
  });
});

describe('MongoDocumentsModel: editing (V7.6)', () => {
  it('opens the whole stored document of a row and saves the edit once', async () => {
    const { model, session, writes } = setup();
    await model.run({ ...QUERY, projection: '{ status: 1 }' });
    session.find = (request) =>
      request.kind === 'find' && request.limit === 1
        ? [parseDocument('{ _id: 1, status: "new", note: "full" }')]
        : undefined;
    const opened = await model.edit(0);
    expect(opened.text).toBe('{\n  _id: 1,\n  status: "new",\n  note: "full"\n}');
    expect(await model.save(opened.token, '{ _id: 1, status: "done", note: "full" }')).toEqual({});
    expect(writes).toHaveLength(1);
    expect(writes[0]).toContain('$literal: { _id: 1, status: "new", note: "full" }');
    expect(writes[0]).toContain('u: { _id: 1, status: "done", note: "full" }');
    await expect(model.save(opened.token, '{ _id: 1 }')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('returns a text that does not parse as a problem, keeping the edit open', async () => {
    const { model, session, writes } = setup();
    await model.run(QUERY);
    session.find = (request) =>
      request.kind === 'find' && request.limit === 1 ? [parseDocument('{ _id: 1 }')] : undefined;
    const opened = await model.edit(0);
    expect(await model.save(opened.token, '{ _id: 1,, }')).toEqual({
      problem: expect.objectContaining({ box: 'document', line: 1 }) as unknown,
    });
    expect(writes).toEqual([]);
    expect(await model.save(opened.token, '{ _id: 1, ok: true }')).toEqual({});
  });

  it('says when the document changed or went before the save', async () => {
    const { model, session, setN } = setup();
    await model.run(QUERY);
    session.find = (request) =>
      request.kind === 'find' && request.limit === 1 ? [parseDocument('{ _id: 1 }')] : undefined;
    const opened = await model.edit(0);
    setN(0);
    await expect(model.save(opened.token, '{ _id: 1, x: 1 }')).rejects.toMatchObject({
      code: 'busy',
    });
    model.discard(opened.token);
    await expect(model.save(opened.token, '{ _id: 1 }')).rejects.toMatchObject({
      code: 'not-found',
    });
    session.find = (request) => (request.kind === 'find' && request.limit === 1 ? [] : undefined);
    await expect(model.edit(0)).rejects.toThrow('deleted meanwhile');
  });

  it('refuses rows that are not on the page and documents without _id', async () => {
    const { model, session } = setup();
    session.documents.set('shop.orders', [parseDocument('{ a: 1 }')]);
    await model.run(QUERY);
    await expect(model.edit(5)).rejects.toMatchObject({ code: 'not-found' });
    await expect(model.edit(0)).rejects.toMatchObject({ code: 'unsupported' });
    await expect(model.delete([0])).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('inserts a document and reads the page again; a bad text is a problem', async () => {
    const { model, session, writes } = setup();
    await model.run(QUERY);
    expect(await model.insert('{ status: "new" }')).toEqual({});
    expect(writes[0]).toMatch(/^\{ insert: "orders", documents: \[\{ _id: ObjectId\(/);
    expect(session.cursors.length).toBeGreaterThan(1);
    expect((await model.insert('[1]')).problem).toMatchObject({ box: 'document' });
  });

  it('deletes the documents of rows by _id, says what they are, and copies them', async () => {
    const { model, writes } = setup();
    await model.run(QUERY);
    expect(model.describe([0, 1, 7])).toEqual(['1', '2']);
    expect(model.copyText([1])).toBe('{\n  _id: 2,\n  status: "shipped",\n  items: 3\n}');
    expect(await model.delete([0, 1])).toBe(1);
    expect(writes[0]).toBe(
      '{ delete: "orders", deletes: [{ q: { _id: 1 }, limit: 1 }, { q: { _id: 2 }, limit: 1 }] }',
    );
  });
});

describe('MongoDocumentsModel: what may change (V7.6)', () => {
  it('lets nothing change on a read-only connection', async () => {
    const { model, writes } = setup({ readOnly: true });
    const state = await model.run(QUERY);
    expect(state).toMatchObject({ readOnly: true, editable: false, insertable: false });
    const refused = { code: 'permission-denied' };
    await expect(model.edit(0)).rejects.toMatchObject(refused);
    await expect(model.save('1', '{}')).rejects.toMatchObject(refused);
    await expect(model.insert('{}')).rejects.toMatchObject(refused);
    await expect(model.delete([0])).rejects.toMatchObject(refused);
    expect(writes).toEqual([]);
  });

  it('only reads a view, and only adds to a time series collection', async () => {
    const view = setup({ collectionType: 'view' });
    expect(await view.model.run(QUERY)).toMatchObject({ editable: false, insertable: false });
    await expect(view.model.insert('{}')).rejects.toThrow('A view shows another collection');
    const series = setup({ collectionType: 'timeseries' });
    expect(await series.model.run(QUERY)).toMatchObject({ editable: false, insertable: true });
    await expect(series.model.edit(0)).rejects.toThrow('time series');
    expect(await series.model.insert('{ at: new Date(0) }')).toEqual({});
  });
});
