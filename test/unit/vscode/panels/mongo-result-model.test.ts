import { describe, expect, it } from 'vitest';
import { parseValue } from '../../../../src/core/mongo/shell-parse';
import { doc, int32, type MongoDocument } from '../../../../src/core/mongo/value';
import type { MongoCursor, MongoRawDocument } from '../../../../src/drivers/mongo-driver';
import { mongoDocumentsProtocol } from '../../../../src/shared/protocols/mongo-documents';
import {
  MAX_RESULT_DOCUMENTS,
  MongoResultModel,
  type MongoResultModelDeps,
} from '../../../../src/vscode/panels/mongo-result-model';

const TEXTS: MongoResultModelDeps['texts'] = {
  count: (count) => `${count} documents`,
  write: (outcome) => `deleted ${outcome.deleted ?? 0}`,
  capped: (count) => `first ${count}`,
};

/** A cursor over `total` numbered documents that records how much was asked of it. */
function cursorOf(total: number) {
  let position = 0;
  const asked: number[] = [];
  let closed = false;
  const cursor: MongoCursor = {
    next: (count: number) => {
      asked.push(count);
      const documents: MongoRawDocument[] = [];
      while (documents.length < count && position < total) {
        position += 1;
        documents.push({ document: doc([['_id', int32(position)]]), size: 10 });
      }
      return Promise.resolve({ documents, done: position >= total });
    },
    close: () => {
      closed = true;
      return Promise.resolve();
    },
  };
  return { cursor, asked, isClosed: () => closed };
}

async function open(
  outcome: MongoResultModelDeps['outcome'],
  pageSize = 2,
): Promise<MongoResultModel> {
  return await MongoResultModel.open({
    connectionName: 'Shop',
    database: 'shop',
    statement: 'db.orders.find()',
    outcome,
    tookMs: 12,
    texts: TEXTS,
    pageSize,
  });
}

describe('MongoResultModel (V7.7)', () => {
  it('shows the first page of a cursor as a read-only result the protocol accepts', async () => {
    const { cursor, asked } = cursorOf(5);
    const model = await open({ kind: 'cursor', cursor, collection: 'orders' });
    const state = model.state();
    expect(mongoDocumentsProtocol.webview.events.state.parse(state)).toEqual(state);
    expect(state).toMatchObject({
      mode: 'result',
      statement: 'db.orders.find()',
      collection: 'orders',
      readOnly: true,
      editable: false,
      insertable: false,
      skip: 0,
      more: true,
      tookMs: 12,
    });
    expect(state.total).toBeUndefined();
    expect(state.rows.map((row) => row.id)).toEqual(['1', '2']);
    // One document more than the page, to know there is another.
    expect(asked).toEqual([3]);
  });

  it('reads on as the user pages forward, and pages back without reading', async () => {
    const { cursor, asked } = cursorOf(5);
    const model = await open({ kind: 'cursor', cursor });
    expect((await model.page(2)).rows.map((row) => row.id)).toEqual(['3', '4']);
    const last = await model.page(4);
    expect(last.rows.map((row) => row.id)).toEqual(['5']);
    expect(last.more).toBe(false);
    expect(last.total).toEqual({ count: '5', exact: true });
    const calls = asked.length;
    expect((await model.page(0)).rows.map((row) => row.id)).toEqual(['1', '2']);
    expect(asked).toHaveLength(calls);
    expect((await model.page(40)).skip).toBe(4);
  });

  it('counts by reading the rest of the cursor', async () => {
    const { cursor } = cursorOf(7);
    const model = await open({ kind: 'cursor', cursor });
    expect((await model.count()).total).toEqual({ count: '7', exact: true });
  });

  it('keeps at most MAX_RESULT_DOCUMENTS documents and says so', async () => {
    const { cursor, isClosed } = cursorOf(MAX_RESULT_DOCUMENTS + 5);
    const model = await open({ kind: 'cursor', cursor }, 50);
    const state = await model.count();
    expect(state.summary).toBe(`first ${MAX_RESULT_DOCUMENTS}`);
    expect(state.total).toBeUndefined();
    expect(state.more).toBe(true);
    expect(isClosed()).toBe(true);
    expect((await model.page(MAX_RESULT_DOCUMENTS + 100)).skip).toBe(MAX_RESULT_DOCUMENTS - 50);
  });

  it('shows a few documents, a count or what a write did', async () => {
    const documents = await open({ kind: 'documents', documents: [doc([['a', int32(1)]])] });
    expect(documents.state()).toMatchObject({ total: { count: '1', exact: true }, more: false });
    expect(documents.state().collection).toBe('');
    const count = await open({ kind: 'count', count: '250' });
    expect(count.state().summary).toBe('250 documents');
    expect(count.state().rows[0]?.text).toBe('{\n  count: NumberLong("250")\n}');
    const write = await open({
      kind: 'write',
      reply: parseValue('{ n: 3, ok: 1 }') as MongoDocument,
      deleted: 3,
    });
    expect(write.state().summary).toBe('deleted 3');
  });

  it('copies and describes rows of the page shown', async () => {
    const { cursor } = cursorOf(5);
    const model = await open({ kind: 'cursor', cursor });
    await model.page(2);
    expect(model.copyText([1])).toBe('{\n  _id: 4\n}');
    expect(model.describe([0, 9])).toEqual(['3']);
    const plain = await open({ kind: 'documents', documents: [doc([['a', int32(1)]])] });
    expect(plain.describe([0])).toEqual(['?']);
  });

  it('refuses every change and a new query: a result is only read', async () => {
    const model = await open({ kind: 'documents', documents: [] });
    for (const attempt of [
      model.run(),
      model.edit(),
      model.save(),
      model.insert(),
      model.delete(),
    ]) {
      await expect(attempt).rejects.toMatchObject({ code: 'unsupported' });
    }
    expect(await model.refresh()).toEqual(model.state());
  });

  it('closes the cursor when it is replaced', async () => {
    const { cursor, isClosed } = cursorOf(5);
    const model = await open({ kind: 'cursor', cursor });
    await model.close();
    expect(isClosed()).toBe(true);
    expect(model.state().more).toBe(true);
  });
});
