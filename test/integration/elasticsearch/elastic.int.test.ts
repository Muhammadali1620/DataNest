import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitRequests } from '../../../src/core/elastic/requests';
import { driver } from '../../../src/drivers/elasticsearch';
import type { ElasticSession } from '../../../src/drivers/elastic-driver';
import {
  callJson,
  createIndex,
  deleteIndex,
  listFields,
  listIndices,
} from '../../../src/services/elasticsearch/catalog';
import { resultState } from '../../../src/services/elasticsearch/result-view';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { parseInDocument, runElasticRequest } from '../../../src/vscode/elastic/elastic-run';
import { TEST_ELASTIC } from '../../helpers/elastic-servers';

// docker/compose.yml `elasticsearch` (V7.8): the client, the tree and requests on a real node.
const SCRATCH = 'datanest-it-scratch';
let root: ElasticSession;

function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'it',
    name: 'it',
    driver: 'elasticsearch',
    host: TEST_ELASTIC.host,
    port: TEST_ELASTIC.port,
    user: TEST_ELASTIC.user.name,
    password: TEST_ELASTIC.user.password,
    options: { connectTimeout: 5 },
    ...overrides,
  };
}

/** Sends a request written as in the editor, through the editor's own path. */
async function send(session: ElasticSession, text: string, readOnly = false) {
  const [request] = splitRequests(text);
  if (request === undefined) {
    throw new Error('no request');
  }
  const result = await runElasticRequest(
    {
      session: () => Promise.resolve(session),
      policy: { name: 'it', production: false, readOnly },
      safeMode: 'off',
      timeoutMs: 10_000,
      ask: () => Promise.resolve(true),
      texts: { readOnly: 'Read-only', blocked: 'Blocked' },
    },
    parseInDocument(request, text),
  );
  if (result.kind !== 'done') {
    throw new Error('cancelled');
  }
  return resultState({
    connectionName: 'it',
    request: text.split('\n')[0] ?? '',
    response: result.response,
    tookMs: 0,
  });
}

beforeAll(async () => {
  root = await driver.openSession(config());
  await root.request({ method: 'DELETE', path: `/${SCRATCH}` });
});

afterAll(async () => {
  await root.request({ method: 'DELETE', path: `/${SCRATCH}` });
  await root.close();
});

describe('Elasticsearch connections (V7.8)', () => {
  it('signs in and says who the cluster is', () => {
    expect(root.server).toEqual({
      version: '8.19.6',
      distribution: 'elasticsearch',
      clusterName: 'docker-cluster',
    });
  });

  it('refuses a wrong password, nobody at all, and a port without a server', async () => {
    await expect(driver.openSession(config({ password: 'wrong' }))).rejects.toMatchObject({
      code: 'auth-failed',
    });
    await expect(
      driver.openSession(config({ user: undefined, password: undefined })),
    ).rejects.toMatchObject({
      code: 'auth-failed',
    });
    await expect(
      driver.openSession(config({ port: 7999, options: { connectTimeout: 1 } })),
    ).rejects.toMatchObject({
      code: 'connection-failed',
    });
    await expect(driver.openSession(config({ ssl: { mode: 'require' } }))).rejects.toMatchObject({
      message: expect.stringContaining('TLS failed') as unknown,
    });
  });

  it('signs in with an API key', async () => {
    const key = await callJson(root, {
      method: 'POST',
      path: '/_security/api_key',
      body: JSON.stringify({ name: 'datanest-it', expiration: '1h' }),
    });
    const encoded =
      key.type === 'object' ? key.members.find(([name]) => name === 'encoded')?.[1] : undefined;
    expect(encoded?.type).toBe('string');
    const session = await driver.openSession(
      config({
        user: undefined,
        password: encoded?.type === 'string' ? encoded.value : '',
        elastic: { auth: 'apiKey' },
      }),
    );
    expect(session.server.clusterName).toBe('docker-cluster');
    await session.close();
  });
});

describe('the tree on the seed (V7.8)', () => {
  it('lists the indices, the hidden ones only when asked', async () => {
    const names = (await listIndices(root, false)).map((index) => index.name);
    expect(names).toEqual(expect.arrayContaining(['datanest-seed', 'logs-2026.10', 'products']));
    expect(names.some((name) => name.startsWith('.'))).toBe(false);
    const all = (await listIndices(root, true)).map((index) => index.name);
    expect(all).toContain('.datanest-hidden');
    const products = (await listIndices(root, false)).find((index) => index.name === 'products');
    expect(products).toMatchObject({ health: 'green', status: 'open', docs: '61' });
  });

  it('lists the fields of a mapping, nested and multi-fields inside their field', async () => {
    const fields = await listFields(root, 'products');
    const byName = new Map(fields.map((field) => [field.name, field]));
    expect(byName.get('name')).toMatchObject({
      type: 'text',
      children: [{ path: 'name.keyword', type: 'keyword' }],
    });
    expect(byName.get('maker')?.type).toBe('object');
    expect(byName.get('maker')?.children.map((child) => child.path)).toEqual([
      'maker.country',
      'maker.name',
    ]);
    expect(byName.get('reviews')?.type).toBe('nested');
    expect(byName.get('location')?.type).toBe('geo_point');
    expect(byName.get('price')?.type).toBe('scaled_float');
    // Through the alias: the reply is keyed by the concrete index.
    expect((await listFields(root, 'logs')).map((field) => field.name)).toEqual([
      'at',
      'level',
      'message',
    ]);
  });

  it('lets a reader list but not change', async () => {
    const reader = await driver.openSession(
      config({ user: TEST_ELASTIC.reader.name, password: TEST_ELASTIC.reader.password }),
    );
    try {
      expect((await listIndices(reader, false)).length).toBeGreaterThan(0);
      await expect(createIndex(reader, 'datanest-it-nope', '')).rejects.toMatchObject({
        code: 'permission-denied',
      });
    } finally {
      await reader.close();
    }
  });

  it('creates an index with its mappings and deletes it', async () => {
    await createIndex(
      root,
      SCRATCH,
      '{ "mappings": { "properties": { "n": { "type": "long" } } } }',
    );
    expect((await listFields(root, SCRATCH)).map((field) => [field.name, field.type])).toEqual([
      ['n', 'long'],
    ]);
    await expect(createIndex(root, SCRATCH, '')).rejects.toThrow(
      'resource_already_exists_exception',
    );
    await deleteIndex(root, SCRATCH);
    await expect(deleteIndex(root, SCRATCH)).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('requests from the editor (V7.8)', () => {
  it('searches and shows hits with every digit of a 64-bit number', async () => {
    const result = await send(
      root,
      'POST /products/_search\n{ "query": { "ids": { "values": ["big", "p1"] } }, "sort": [{ "sku": "desc" }] }',
    );
    expect(result.status).toBe(200);
    expect(result.summary).toMatchObject({ kind: 'hits', total: '2', relation: 'eq', shown: 2 });
    expect(result.columns.slice(0, 2)).toEqual(['_index', '_id']);
    const stock = result.columns.indexOf('stock');
    expect(result.rows[0]?.cells[stock]?.text).toBe('9007199254740993');
    expect(result.text).toContain('"stock": 9007199254740993');
  });

  it('counts, reads _cat as text and says why a request failed', async () => {
    expect(
      (await send(root, 'GET /products/_count\n{ "query": { "term": { "active": false } } }'))
        .summary,
    ).toEqual({
      kind: 'count',
      total: '10',
    });
    expect((await send(root, 'GET /_cat/indices/products?v')).text).toContain('products');
    const missing = await send(root, 'GET /nope/_search');
    expect(missing.status).toBe(404);
    expect(missing.summary?.error).toContain('index_not_found_exception');
    const bad = await send(root, 'POST /products/_search\n{ "query": { "nope": {} } }');
    expect(bad.status).toBe(400);
  });

  it('writes with _bulk as NDJSON, updates and deletes by query', async () => {
    await send(root, `PUT /${SCRATCH}`);
    const bulk = await send(
      root,
      `POST /_bulk?refresh=true\n{ "index": { "_index": "${SCRATCH}", "_id": "1" } }\n{ "n": 1 }\n{ "index": { "_index": "${SCRATCH}", "_id": "2" } }\n{ "n": 2 }`,
    );
    expect(bulk.text).toContain('"errors": false');
    await send(
      root,
      `POST /${SCRATCH}/_update_by_query?refresh=true\n{ "query": { "term": { "n": 1 } }, "script": { "source": "ctx._source.n = 10" } }`,
    );
    expect(
      (await send(root, `GET /${SCRATCH}/_count\n{ "query": { "term": { "n": 10 } } }`)).summary
        ?.total,
    ).toBe('1');
    await send(
      root,
      `POST /${SCRATCH}/_delete_by_query?refresh=true\n{ "query": { "match_all": {} } }`,
    );
    expect((await send(root, `GET /${SCRATCH}/_count`)).summary?.total).toBe('0');
    await send(root, `DELETE /${SCRATCH}`);
  });

  it('refuses a write on a read-only connection before it reaches the server', async () => {
    await expect(send(root, `PUT /${SCRATCH}`, true)).rejects.toMatchObject({
      code: 'permission-denied',
    });
    expect((await root.request({ method: 'HEAD', path: `/${SCRATCH}` })).status).toBe(404);
    expect((await send(root, 'POST /products/_search\n{ "size": 0 }', true)).status).toBe(200);
  });
});
