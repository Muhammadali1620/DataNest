import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { parseDocument } from '../../../../src/core/mongo/shell-parse';
import type { ConnectionInput } from '../../../../src/shared/connection';
import {
  type MongoTreeCommandDeps,
  mongoTreeCommandHandlers,
  type TextQuestion,
} from '../../../../src/vscode/mongodb/mongo-tree-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeMongoSession } from '../../../helpers/fake-mongo';

const TEXTS: MongoTreeCommandDeps['texts'] = {
  newDatabase: 'New Database',
  databaseName: 'Database name',
  firstCollection: 'First collection',
  renameCollection: 'Rename',
  newName: (current) => `New name of ${current}`,
  dropDatabase: (name) => `Drop ${name}?`,
  typeToDrop: (name) => `Type ${name}`,
  typeExactly: 'Exactly',
  dropCollection: (name, view) => `Drop ${view ? 'view' : 'collection'} ${name}?`,
  dropIndex: (name, collection) => `Drop ${name} of ${collection}?`,
  dropAction: 'Drop',
  productionDetail: (connection) => `${connection} is production`,
  changeAction: 'Change',
  readOnly: 'Read-only',
  noMongo: 'No MongoDB',
  renameView: 'Views cannot be renamed',
};

interface Harness {
  readonly session: FakeMongoSession;
  readonly refreshed: (TreeNode | undefined)[];
  readonly questions: TextQuestion[];
  readonly confirmations: { message: string; detail: string | undefined }[];
  answers: (string | undefined)[];
  confirmAnswer: boolean;
  connections: Map<string, ConnectionInput & { id: string }>;
  picked: string | undefined;
  readonly closed: string[];
  readonly handlers: ReturnType<typeof mongoTreeCommandHandlers>;
}

function harness(): Harness {
  const session = new FakeMongoSession();
  const state: Harness = {
    session,
    refreshed: [],
    questions: [],
    confirmations: [],
    answers: [],
    confirmAnswer: true,
    connections: new Map([
      ['m', { id: 'm', name: 'Shop', driver: 'mongodb', host: 'h' }],
      ['p', { id: 'p', name: 'Prod', driver: 'mongodb', host: 'h', production: true }],
      ['r', { id: 'r', name: 'Ro', driver: 'mongodb', host: 'h', readOnly: true }],
      ['s', { id: 's', name: 'Sql', driver: 'mysql', host: 'h' }],
    ]),
    picked: 'm',
    closed: [],
    handlers: undefined as never,
  };
  (state as { handlers: Harness['handlers'] }).handlers = mongoTreeCommandHandlers({
    manager: { acquireMongo: () => Promise.resolve(session) },
    store: {
      get: (id) => state.connections.get(id),
      list: () => [...state.connections.values()],
    },
    tree: { refresh: (node) => state.refreshed.push(node) },
    pickConnection: (ids) =>
      Promise.resolve(ids.includes(state.picked ?? '') ? state.picked : undefined),
    askText: (question) => {
      state.questions.push(question);
      return Promise.resolve(state.answers.shift());
    },
    askNewCollection: () => Promise.resolve({ name: 'events', options: { kind: 'collection' } }),
    askIndex: () =>
      Promise.resolve({
        keys: parseDocument('{ email: 1 }'),
        options: parseDocument('{ unique: true }'),
      }),
    confirm: (message, detail) => {
      state.confirmations.push({ message, detail });
      return Promise.resolve(state.confirmAnswer);
    },
    texts: TEXTS,
    closePages: (connectionId, database, collection) => {
      state.closed.push(`${connectionId}/${database}/${collection ?? '*'}`);
    },
  });
  return state;
}

const database = (connectionId: string): TreeNode => ({
  kind: 'mongoDatabase',
  connectionId,
  database: 'shop',
});
const orders = (
  connectionId: string,
  collectionType: 'collection' | 'view' = 'collection',
): TreeNode => ({
  kind: 'mongoCollection',
  connectionId,
  database: 'shop',
  collection: 'orders',
  collectionType,
});
const index = (connectionId: string): TreeNode => ({
  kind: 'mongoIndex',
  connectionId,
  database: 'shop',
  collection: 'orders',
  index: {
    name: 'email_1',
    keys: '{ email: 1 }',
    primary: false,
    unique: true,
    sparse: false,
    hidden: false,
  },
});

describe('MongoDB tree commands (V7.5)', () => {
  let h: Harness;

  beforeEach(() => {
    h = harness();
  });

  it('creates a database with its first collection, checking both names as typed', async () => {
    h.answers = ['analytics', 'visits'];
    await h.handlers.newDatabase({ kind: 'connection', connectionId: 'm' });
    expect(h.session.commands).toEqual(['analytics: { create: "visits" }']);
    expect(h.refreshed).toEqual([{ kind: 'connection', connectionId: 'm' }]);
    expect(h.questions[0]?.check?.('a b')).toBeDefined();
    expect(h.questions[1]?.check?.('system.x')).toBeDefined();
  });

  it('picks a MongoDB connection when run from the palette', async () => {
    h.answers = ['analytics', 'visits'];
    await h.handlers.newDatabase(undefined);
    expect(h.session.commands).toHaveLength(1);
    h.picked = undefined;
    await h.handlers.newDatabase(undefined);
    expect(h.session.commands).toHaveLength(1);
  });

  it('says there is no MongoDB connection, or that this one is not', async () => {
    h.connections = new Map([['s', { id: 's', name: 'Sql', driver: 'mysql', host: 'h' }]]);
    await expect(h.handlers.newDatabase(undefined)).rejects.toThrow('No MongoDB');
    await expect(h.handlers.newDatabase('s')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('does nothing when a question is dismissed', async () => {
    h.answers = ['analytics', undefined];
    await h.handlers.newDatabase('m');
    expect(h.session.commands).toEqual([]);
    expect(h.refreshed).toEqual([]);
  });

  it('drops a database only after the question and its name typed back', async () => {
    h.answers = ['shop'];
    await h.handlers.dropDatabase(database('m'));
    expect(h.confirmations).toEqual([{ message: 'Drop shop?', detail: undefined }]);
    expect(h.questions[0]?.check?.('shop')).toBeUndefined();
    expect(h.questions[0]?.check?.('Shop')).toBe('Exactly');
    expect(h.session.commands).toEqual(['shop: { dropDatabase: 1 }']);
    h.answers = [undefined];
    await h.handlers.dropDatabase(database('m'));
    h.confirmAnswer = false;
    await h.handlers.dropDatabase(database('m'));
    expect(h.session.commands).toHaveLength(1);
  });

  it('marks a drop on production in its one question', async () => {
    h.answers = ['shop'];
    await h.handlers.dropDatabase(database('p'));
    expect(h.confirmations).toEqual([{ message: 'Drop shop?', detail: 'Prod is production' }]);
  });

  it('creates a collection and refreshes its database', async () => {
    await h.handlers.newCollection(database('m'));
    expect(h.session.commands).toEqual(['shop: { create: "events" }']);
    expect(h.refreshed).toEqual([database('m')]);
  });

  it('asks before a change on production, and stops when the answer is no', async () => {
    h.confirmAnswer = false;
    await h.handlers.newCollection(database('p'));
    expect(h.confirmations).toEqual([{ message: 'Prod is production', detail: undefined }]);
    expect(h.session.commands).toEqual([]);
    h.confirmAnswer = true;
    await h.handlers.newCollection(database('p'));
    expect(h.session.commands).toHaveLength(1);
  });

  it('refuses every change on a read-only connection', async () => {
    h.answers = ['x', 'y', 'shop', 'renamed'];
    const refused = { code: 'permission-denied', message: 'Read-only' };
    await expect(h.handlers.newDatabase('r')).rejects.toMatchObject(refused);
    await expect(h.handlers.dropDatabase(database('r'))).rejects.toMatchObject(refused);
    await expect(h.handlers.newCollection(database('r'))).rejects.toMatchObject(refused);
    await expect(h.handlers.dropCollection(orders('r'))).rejects.toMatchObject(refused);
    await expect(h.handlers.newIndex(orders('r'))).rejects.toMatchObject(refused);
    await expect(h.handlers.dropIndex(index('r'))).rejects.toMatchObject(refused);
    await expect(h.handlers.renameCollection(orders('r'))).rejects.toMatchObject(refused);
    expect(h.session.commands).toEqual([]);
  });

  it('renames a collection, skipping an unchanged name, and refuses views', async () => {
    h.answers = ['orders', 'orders_2025'];
    await h.handlers.renameCollection(orders('m'));
    expect(h.session.commands).toEqual([]);
    await h.handlers.renameCollection(orders('m'));
    expect(h.session.commands).toEqual([
      'admin: { renameCollection: "shop.orders", to: "shop.orders_2025", dropTarget: false }',
    ]);
    expect(h.questions[0]?.value).toBe('orders');
    await expect(h.handlers.renameCollection(orders('m', 'view'))).rejects.toThrow(
      'Views cannot be renamed',
    );
  });

  it('drops a collection or a view after a question that says which', async () => {
    await h.handlers.dropCollection(orders('m'));
    await h.handlers.dropCollection(orders('m', 'view'));
    expect(h.confirmations.map((one) => one.message)).toEqual([
      'Drop collection orders?',
      'Drop view orders?',
    ]);
    expect(h.session.commands).toEqual(['shop: { drop: "orders" }', 'shop: { drop: "orders" }']);
  });

  it('creates an index on a collection and refreshes it; a view has none', async () => {
    await h.handlers.newIndex(orders('m'));
    expect(h.session.commands).toEqual([
      'shop: { createIndexes: "orders", indexes: [{ key: { email: 1 }, name: "email_1", unique: true }] }',
    ]);
    expect(h.refreshed).toEqual([orders('m')]);
    await h.handlers.newIndex(orders('m', 'view'));
    expect(h.session.commands).toHaveLength(1);
  });

  it('drops an index after a question and refreshes its collection', async () => {
    await h.handlers.dropIndex(index('m'));
    expect(h.confirmations[0]?.message).toBe('Drop email_1 of orders?');
    expect(h.session.commands).toEqual(['shop: { dropIndexes: "orders", index: "email_1" }']);
    expect(h.refreshed).toEqual([orders('m')]);
  });

  it('ignores nodes it is not for', async () => {
    for (const handler of Object.values(h.handlers)) {
      if (handler !== h.handlers.newDatabase) {
        await handler({ kind: 'message', text: 'x' });
      }
    }
    expect(h.session.commands).toEqual([]);
  });

  it('passes the server’s refusal on', async () => {
    h.session.failure = new DbError('constraint', 'Collection already exists');
    await expect(h.handlers.newCollection(database('m'))).rejects.toThrow('already exists');
  });

  it('closes the documents pages of what it drops or renames (V7.6)', async () => {
    h.answers = ['shop', 'orders_old'];
    await h.handlers.dropDatabase(database('m'));
    await h.handlers.renameCollection(orders('m'));
    await h.handlers.dropCollection(orders('m'));
    expect(h.closed).toEqual(['m/shop/*', 'm/shop/orders', 'm/shop/orders']);
  });
});
