import { describe, expect, it } from 'vitest';
import { parseShellStatement } from '../../../../src/core/mongo/shell-command';
import { parseValue } from '../../../../src/core/mongo/shell-parse';
import type { MongoDocument } from '../../../../src/core/mongo/value';
import type { SafeMode } from '../../../../src/services/safe-mode';
import {
  type MongoRunDeps,
  type MongoRunQuestion,
  parseInDocument,
  queryTemplate,
  runMongoStatement,
} from '../../../../src/vscode/mongodb/mongo-run';
import { FakeMongoSession } from '../../../helpers/fake-mongo';

function reply(text: string): MongoDocument {
  return parseValue(text) as MongoDocument;
}

function setup(
  options: { readOnly?: boolean; production?: boolean; safeMode?: SafeMode; answer?: boolean } = {},
) {
  const session = new FakeMongoSession(() => reply('{ n: 1, ok: 1 }'));
  const questions: MongoRunQuestion[] = [];
  let clock = 0;
  const deps: MongoRunDeps = {
    session: () => Promise.resolve(session),
    policy: {
      name: 'Shop',
      production: options.production === true,
      readOnly: options.readOnly === true,
    },
    safeMode: options.safeMode ?? 'confirm',
    maxTimeMS: 0,
    ask: (question) => {
      questions.push(question);
      return Promise.resolve(options.answer ?? true);
    },
    texts: { readOnly: 'Read-only', blocked: 'Blocked' },
    now: () => (clock += 5),
  };
  const go = async (text: string) =>
    await runMongoStatement(deps, 'shop', parseShellStatement(text), text);
  return { session, questions, go };
}

describe('runMongoStatement (V7.7)', () => {
  it('runs a read at once, in the database it names, with the time it took', async () => {
    const { go, questions, session } = setup({ production: true, readOnly: true });
    const result = await go('db.getSiblingDB("logs").events.find()');
    expect(result).toMatchObject({ kind: 'done', database: 'logs', tookMs: 5 });
    expect(questions).toEqual([]);
    expect(session.cursors[0]?.database).toBe('logs');
    expect(await go('use other')).toMatchObject({ kind: 'done', database: 'shop' });
  });

  it('runs a write without a question on an ordinary connection', async () => {
    const { go, questions, session } = setup();
    expect(await go('db.orders.insertOne({ a: 1 })')).toMatchObject({ kind: 'done' });
    expect(questions).toEqual([]);
    expect(session.commands).toHaveLength(1);
  });

  it('refuses every write on a read-only connection, before it reaches the server', async () => {
    const { go, session } = setup({ readOnly: true });
    for (const text of [
      'db.orders.insertOne({ a: 1 })',
      'db.orders.deleteMany({})',
      'db.runCommand({ insert: "x", documents: [] })',
      'db.orders.aggregate([{ $out: "copy" }])',
    ]) {
      await expect(go(text)).rejects.toMatchObject({
        code: 'permission-denied',
        message: 'Read-only',
      });
    }
    expect(session.commands).toEqual([]);
    expect(session.cursors).toEqual([]);
  });

  it('asks once before a write on production, and stops on no', async () => {
    const yes = setup({ production: true });
    expect(await yes.go('db.orders.updateOne({ a: 1 }, { $set: { b: 1 } })')).toMatchObject({
      kind: 'done',
    });
    expect(yes.questions).toEqual([
      {
        kind: 'production',
        statement: 'db.orders.updateOne({ a: 1 }, { $set: { b: 1 } })',
        production: true,
      },
    ]);
    const no = setup({ production: true, answer: false });
    expect(await no.go('db.orders.insertOne({})')).toEqual({ kind: 'cancelled' });
    expect(no.session.commands).toEqual([]);
  });

  it('asks before a dangerous write in safe mode, also saying when it is production', async () => {
    const plain = setup();
    await plain.go('db.orders.deleteMany({})');
    expect(plain.questions).toEqual([
      { kind: 'dangerous', statement: 'db.orders.deleteMany({})', production: false },
    ]);
    const production = setup({ production: true });
    await production.go('db.orders.drop()');
    expect(production.questions).toEqual([
      { kind: 'dangerous', statement: 'db.orders.drop()', production: true },
    ]);
  });

  it('blocks dangerous writes in safe mode block, and lets them by when it is off', async () => {
    const blocked = setup({ safeMode: 'block' });
    await expect(blocked.go('db.dropDatabase()')).rejects.toMatchObject({ message: 'Blocked' });
    expect(blocked.session.commands).toEqual([]);
    // Ordinary writes are not safe mode's business.
    expect(await blocked.go('db.orders.deleteMany({ a: 1 })')).toMatchObject({ kind: 'done' });
    const off = setup({ safeMode: 'off' });
    expect(await off.go('db.orders.deleteMany({})')).toMatchObject({ kind: 'done' });
    expect(off.questions).toEqual([]);
    const offProduction = setup({ safeMode: 'off', production: true });
    await offProduction.go('db.orders.deleteMany({})');
    expect(offProduction.questions[0]?.kind).toBe('production');
  });
});

describe('parseInDocument (V7.7)', () => {
  it('says where a statement is wrong in the whole document', () => {
    const document = 'show dbs\n\ndb.orders.find({ a: 1,, })';
    const offset = document.indexOf('db.');
    expect(() => parseInDocument(document, offset, document.slice(offset))).toThrow(
      expect.objectContaining({
        code: 'syntax',
        message: expect.stringMatching(/^3:\d+ /) as unknown,
      }),
    );
    expect(parseInDocument(document, 0, 'show dbs')).toEqual({ kind: 'show', what: 'databases' });
  });
});

describe('queryTemplate (V7.7)', () => {
  it('starts a query of a collection with a find and a pipeline', () => {
    const node = {
      kind: 'mongoCollection' as const,
      connectionId: 'c',
      database: 'shop',
      collection: 'orders',
      collectionType: 'collection' as const,
    };
    expect(queryTemplate(node)).toBe(
      'db.orders.find({})\n\ndb.orders.aggregate([\n  { $match: {} },\n  { $limit: 20 }\n])\n',
    );
    expect(queryTemplate({ ...node, collection: 'my-orders', collectionType: 'view' })).toBe(
      'db.getCollection("my-orders").find({})\n',
    );
    expect(queryTemplate(undefined)).toBe('show collections\n');
    expect(queryTemplate({ kind: 'mongoDatabase', connectionId: 'c', database: 'shop' })).toBe(
      'show collections\n',
    );
  });
});
