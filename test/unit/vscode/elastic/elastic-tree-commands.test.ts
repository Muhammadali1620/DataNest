import { beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionInput } from '../../../../src/shared/connection';
import {
  type ElasticTreeCommandDeps,
  elasticTreeCommandHandlers,
} from '../../../../src/vscode/elastic/elastic-tree-commands';
import type { TextQuestion } from '../../../../src/vscode/mongodb/mongo-tree-commands';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeElasticSession } from '../../../helpers/fake-elastic';

const TEXTS: ElasticTreeCommandDeps['texts'] = {
  newIndex: 'New Index',
  indexName: 'Name',
  indexBody: 'Body',
  deleteIndex: (name) => `Delete ${name}?`,
  typeToDelete: (name) => `Type ${name}`,
  typeExactly: 'Exactly',
  deleteAction: 'Delete',
  productionDetail: (connection) => `${connection} is production`,
  changeAction: 'Change',
  readOnly: 'Read-only',
  noElastic: 'No Elasticsearch',
};

function setup() {
  const session = new FakeElasticSession();
  const state = {
    answers: [] as (string | undefined)[],
    questions: [] as TextQuestion[],
    confirmations: [] as { message: string; detail: string | undefined }[],
    confirmAnswer: true,
    refreshed: [] as (TreeNode | undefined)[],
    connections: new Map<string, ConnectionInput & { id: string }>([
      ['e', { id: 'e', name: 'Search', driver: 'elasticsearch', host: 'h' }],
      ['p', { id: 'p', name: 'Prod', driver: 'elasticsearch', host: 'h', production: true }],
      ['r', { id: 'r', name: 'Ro', driver: 'elasticsearch', host: 'h', readOnly: true }],
      ['s', { id: 's', name: 'Sql', driver: 'mysql', host: 'h' }],
    ]),
  };
  const handlers = elasticTreeCommandHandlers({
    manager: { acquireElastic: () => Promise.resolve(session) },
    store: { get: (id) => state.connections.get(id), list: () => [...state.connections.values()] },
    tree: { refresh: (node) => state.refreshed.push(node) },
    pickConnection: (ids) => Promise.resolve(ids[0]),
    askText: (question) => {
      state.questions.push(question);
      return Promise.resolve(state.answers.shift());
    },
    confirm: (message, detail) => {
      state.confirmations.push({ message, detail });
      return Promise.resolve(state.confirmAnswer);
    },
    texts: TEXTS,
  });
  return { session, state, handlers };
}

const index = (connectionId: string): TreeNode => ({
  kind: 'elasticIndex',
  connectionId,
  index: { name: 'products', status: 'open', hidden: false },
});

describe('Elasticsearch tree commands (V7.8)', () => {
  let h: ReturnType<typeof setup>;

  beforeEach(() => {
    h = setup();
  });

  it('creates an index with its settings, checking the name as typed', async () => {
    h.state.answers = ['items', '{"settings":{}}'];
    await h.handlers.newIndex({ kind: 'connection', connectionId: 'e' });
    expect(h.session.requests).toEqual(['PUT /items {"settings":{}}']);
    expect(h.state.refreshed).toEqual([{ kind: 'connection', connectionId: 'e' }]);
    expect(h.state.questions[0]?.check?.('Items')).toBeDefined();
  });

  it('picks a connection from the palette and stops when a question is dismissed', async () => {
    h.state.answers = ['items', undefined];
    await h.handlers.newIndex(undefined);
    expect(h.session.requests).toEqual([]);
  });

  it('asks on production before creating', async () => {
    h.state.answers = ['items', ''];
    h.state.confirmAnswer = false;
    await h.handlers.newIndex('p');
    expect(h.state.confirmations).toEqual([{ message: 'Prod is production', detail: undefined }]);
    expect(h.session.requests).toEqual([]);
  });

  it('deletes an index after the question and its name typed back', async () => {
    h.state.answers = ['products'];
    await h.handlers.deleteIndex(index('e'));
    expect(h.state.confirmations).toEqual([{ message: 'Delete products?', detail: undefined }]);
    expect(h.state.questions[0]?.check?.('product')).toBe('Exactly');
    expect(h.session.requests).toEqual(['DELETE /products']);
    h.state.answers = [undefined];
    await h.handlers.deleteIndex(index('p'));
    expect(h.state.confirmations[1]?.detail).toBe('Prod is production');
    expect(h.session.requests).toHaveLength(1);
  });

  it('refuses every change on a read-only connection', async () => {
    await expect(h.handlers.newIndex('r')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(h.handlers.deleteIndex(index('r'))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect(h.session.requests).toEqual([]);
  });

  it('says when the connection is not Elasticsearch, or there is none', async () => {
    await expect(h.handlers.newIndex('s')).rejects.toMatchObject({ code: 'unsupported' });
    h.state.connections = new Map();
    await expect(h.handlers.newIndex(undefined)).rejects.toThrow('No Elasticsearch');
    await h.handlers.deleteIndex({ kind: 'message', text: 'x' });
  });
});
