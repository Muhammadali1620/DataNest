import { describe, expect, it } from 'vitest';
import {
  callJson,
  createIndex,
  deleteIndex,
  indexNameProblem,
  listFields,
  listIndices,
} from '../../../../src/services/elasticsearch/catalog';
import { FakeElasticSession, json } from '../../../helpers/fake-elastic';

const CAT = [
  { index: 'products', health: 'green', status: 'open', 'docs.count': '61', 'store.size': '12599' },
  { index: '.hidden', health: 'yellow', status: 'open', 'docs.count': '0', 'store.size': '227' },
  { index: 'logs-10', health: 'red', status: 'close' },
  { index: 'logs-9', health: 'unknown', status: 'open', 'docs.count': null },
  { name: 'not an index row' },
];

describe('listIndices (V7.8)', () => {
  it('lists open and closed indices, sorted, numbers kept as text', async () => {
    const session = new FakeElasticSession(() => json(CAT));
    expect(await listIndices(session, false)).toEqual([
      { name: 'logs-9', status: 'open', hidden: false },
      { name: 'logs-10', health: 'red', status: 'close', hidden: false },
      {
        name: 'products',
        health: 'green',
        status: 'open',
        docs: '61',
        size: '12599',
        hidden: false,
      },
    ]);
    expect(session.requests[0]).toBe(
      'GET /_cat/indices?format=json&bytes=b&h=index,health,status,docs.count,store.size&expand_wildcards=open,closed',
    );
  });

  it('adds hidden and system indices only when asked', async () => {
    const session = new FakeElasticSession(() => json(CAT));
    const all = await listIndices(session, true);
    expect(all.map((index) => index.name)).toEqual(['.hidden', 'logs-9', 'logs-10', 'products']);
    expect(session.requests[0]).toContain('expand_wildcards=all');
  });

  it('fails with the server’s reason', async () => {
    const session = new FakeElasticSession(() =>
      json({ error: { root_cause: [{ type: 'security_exception', reason: 'no' }] } }, 403),
    );
    await expect(listIndices(session, false)).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('listFields (V7.8)', () => {
  it('nests objects, nested fields and multi-fields as the mapping does', async () => {
    const session = new FakeElasticSession(() =>
      json({
        'logs-2026.10': {
          mappings: {
            properties: {
              name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
              maker: { properties: { country: { type: 'keyword' } } },
              reviews: { type: 'nested', properties: { stars: { type: 'integer' } } },
              weird: {},
            },
          },
        },
      }),
    );
    const fields = await listFields(session, 'logs');
    expect(session.requests[0]).toBe('GET /logs/_mapping');
    expect(
      fields.map((field) => [field.name, field.type, field.children.map((child) => child.path)]),
    ).toEqual([
      ['name', 'text', ['name.keyword']],
      ['maker', 'object', ['maker.country']],
      ['reviews', 'nested', ['reviews.stars']],
      ['weird', 'unknown', []],
    ]);
  });

  it('has no fields for an empty mapping', async () => {
    expect(
      await listFields(new FakeElasticSession(() => json({ empty: { mappings: {} } })), 'empty'),
    ).toEqual([]);
    expect(await listFields(new FakeElasticSession(() => json({})), 'gone')).toEqual([]);
  });

  it('escapes the index name in the path', async () => {
    const session = new FakeElasticSession(() => json({}));
    await listFields(session, 'a#b');
    expect(session.requests[0]).toBe('GET /a%23b/_mapping');
  });
});

describe('index changes (V7.8)', () => {
  it('refuses names Elasticsearch refuses', () => {
    expect(indexNameProblem('logs-2026.10')).toBeUndefined();
    for (const name of [
      '',
      'Upper',
      'a b',
      'a*b',
      'a,b',
      '-a',
      '_a',
      '+a',
      '.',
      '..',
      'a#b',
      'a:b',
    ]) {
      expect(indexNameProblem(name)).toBeDefined();
    }
    expect(indexNameProblem('é'.repeat(200))).toContain('255 bytes');
  });

  it('creates an index with its settings, checked as JSON first', async () => {
    const session = new FakeElasticSession();
    await createIndex(session, 'items', ' { "settings": { "number_of_shards": 1 } } ');
    await createIndex(session, 'plain', '');
    expect(session.requests).toEqual([
      'PUT /items { "settings": { "number_of_shards": 1 } }',
      'PUT /plain',
    ]);
    await expect(createIndex(session, 'bad', '{ settings }')).rejects.toThrow(
      'The settings are not JSON',
    );
    await expect(createIndex(session, 'Bad', '')).rejects.toMatchObject({ code: 'syntax' });
    expect(session.requests).toHaveLength(2);
  });

  it('passes a refusal of the server on', async () => {
    const session = new FakeElasticSession(() =>
      json(
        {
          error: { root_cause: [{ type: 'resource_already_exists_exception', reason: 'exists' }] },
        },
        400,
      ),
    );
    await expect(createIndex(session, 'items', '')).rejects.toThrow(
      'resource_already_exists_exception',
    );
  });

  it('deletes one index by name, never a pattern', async () => {
    const session = new FakeElasticSession();
    await deleteIndex(session, 'items');
    expect(session.requests).toEqual(['DELETE /items']);
    for (const name of ['*', 'a*', '_all', 'a,b']) {
      await expect(deleteIndex(session, name)).rejects.toMatchObject({ code: 'unsupported' });
    }
  });

  it('wants JSON back from callJson', async () => {
    await expect(
      callJson(
        new FakeElasticSession(() => ({ status: 200, body: 'plain', contentType: 'text/plain' })),
        {
          method: 'GET',
          path: '/x',
        },
      ),
    ).rejects.toThrow('is not JSON');
  });
});
