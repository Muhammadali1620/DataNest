import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formatJsonLine, jsonNumberText, member } from '../../../src/core/json/json-tree';
import { driver } from '../../../src/drivers/elasticsearch';
import type { ElasticSession } from '../../../src/drivers/elastic-driver';
import { callJson, createIndex } from '../../../src/services/elasticsearch/catalog';
import {
  createBodyOf,
  exportIndex,
  importIndex,
  type IndexFileFormat,
  readFileHeader,
} from '../../../src/services/elasticsearch/index-files';
import { TEST_ELASTIC } from '../../helpers/elastic-servers';

// docker/compose.yml `elasticsearch` (V7.8): an index to a file and back (V13.11), on a real node.
const SOURCE = 'datanest-it-files-source';
const COPY = 'datanest-it-files-copy';
const BULK_COPY = 'datanest-it-files-bulk';
const DOCUMENTS = 2300;
let session: ElasticSession;

class MemorySink {
  text = '';

  write(text: string): Promise<void> {
    this.text += text;
    return Promise.resolve();
  }
}

async function* chunks(text: string): AsyncGenerator<{ text: string }> {
  // Several pieces, cut in the middle of lines.
  for (let at = 0; at < text.length; at += 100_000) {
    yield await Promise.resolve({ text: text.slice(at, at + 100_000) });
  }
}

async function exported(index: string, format: IndexFileFormat): Promise<string> {
  const sink = new MemorySink();
  await exportIndex({ session, index, format, sink });
  return sink.text;
}

async function count(index: string): Promise<number> {
  await session.request({ method: 'POST', path: `/${index}/_refresh` });
  const reply = await callJson(session, { method: 'GET', path: `/${index}/_count` });
  return Number(jsonNumberText(member(reply, 'count')));
}

async function drop(index: string): Promise<void> {
  await session.request({ method: 'DELETE', path: `/${index}` });
}

beforeAll(async () => {
  session = await driver.openSession({
    id: 'it',
    name: 'it',
    driver: 'elasticsearch',
    host: TEST_ELASTIC.host,
    port: TEST_ELASTIC.port,
    user: TEST_ELASTIC.user.name,
    password: TEST_ELASTIC.user.password,
    options: { connectTimeout: 5 },
  });
  for (const index of [SOURCE, COPY, BULK_COPY]) {
    await drop(index);
  }
  await createIndex(
    session,
    SOURCE,
    JSON.stringify({
      settings: { index: { number_of_shards: 1, number_of_replicas: 0 } },
      mappings: {
        properties: {
          name: { type: 'keyword' },
          n: { type: 'long' },
          note: { type: 'text' },
        },
      },
    }),
  );
  // Documents with ids, a number past 2^53, and a routing value on one of them.
  const lines: string[] = [];
  for (let index = 0; index < DOCUMENTS; index += 1) {
    lines.push(JSON.stringify({ index: { _id: `d${index}` } }));
    lines.push(
      index === 0
        ? '{"name":"first","n":9007199254740993,"note":"Ünï — cödé","price":1.10}'
        : `{"name":"n${index}","n":${index},"note":"row ${index}"}`,
    );
  }
  const response = await session.request({
    method: 'POST',
    path: `/${SOURCE}/_bulk?refresh=true`,
    body: `${lines.join('\n')}\n`,
    ndjson: true,
  });
  expect(response.status).toBe(200);
}, 60_000);

afterAll(async () => {
  for (const index of [SOURCE, COPY, BULK_COPY]) {
    await drop(index);
  }
  await session.close();
});

describe('index files on a real node (V13.11)', () => {
  it('exports every document, more than one scroll page holds', async () => {
    const text = await exported(SOURCE, 'documents');
    const lines = text.split('\n').filter((line) => line !== '');
    expect(lines).toHaveLength(DOCUMENTS);
    const ids = new Set(lines.map((line) => (JSON.parse(line) as { _id: string })._id));
    expect(ids.size).toBe(DOCUMENTS);
  });

  it('keeps a number past 2^53, a trailing zero and non-ASCII text', async () => {
    const text = await exported(SOURCE, 'documents');
    const first = text.split('\n').find((line) => line.includes('"_id":"d0"')) ?? '';
    expect(first).toContain('"n":9007199254740993');
    expect(first).toContain('"price":1.10');
    expect(first).toContain('Ünï — cödé');
  });

  it('writes a header whose settings and mappings make the index again', async () => {
    const text = await exported(SOURCE, 'documents-with-mapping');
    const header = await readFileHeader(chunks(text));
    expect(header?.index).toBe(SOURCE);
    const body = createBodyOf(header);
    expect(body).not.toContain('"uuid"');
    expect(body).not.toContain('"creation_date"');
    expect(body).not.toContain('"provided_name"');
    await createIndex(session, COPY, body);
    const mapping = await callJson(session, { method: 'GET', path: `/${COPY}/_mapping` });
    const properties = member(member(member(mapping, COPY), 'mappings'), 'properties');
    expect(formatJsonLine(member(properties, 'n') ?? { type: 'null' })).toBe('{"type":"long"}');
    expect(formatJsonLine(member(properties, 'name') ?? { type: 'null' })).toBe(
      '{"type":"keyword"}',
    );
  });

  it('loads the file into the index made from its header, document for document', async () => {
    const text = await exported(SOURCE, 'documents-with-mapping');
    const report = await importIndex({
      session,
      index: COPY,
      chunks: chunks(text),
      mode: 'skip',
      ids: 'keep',
      op: 'create',
    });
    expect(report).toMatchObject({ inserted: DOCUMENTS, refused: 0, cancelled: false });
    expect(await count(COPY)).toBe(DOCUMENTS);
    const doc = await callJson(session, { method: 'GET', path: `/${COPY}/_doc/d0` });
    expect(formatJsonLine(member(doc, '_source') ?? { type: 'null' })).toBe(
      '{"name":"first","n":9007199254740993,"note":"Ünï — cödé","price":1.10}',
    );
  });

  it('refuses documents that exist when told to create, and names their lines', async () => {
    const text = await exported(SOURCE, 'documents');
    const report = await importIndex({
      session,
      index: COPY,
      chunks: chunks(text),
      mode: 'skip',
      ids: 'keep',
      op: 'create',
    });
    expect(report.inserted).toBe(0);
    expect(report.refused).toBe(DOCUMENTS);
    expect(report.problems[0]).toMatchObject({ line: 1 });
    expect(report.problems[0]?.message).toContain('version_conflict_engine_exception');
    expect(await count(COPY)).toBe(DOCUMENTS);
  });

  it('replaces documents that exist when told to index', async () => {
    const report = await importIndex({
      session,
      index: COPY,
      chunks: chunks('{"_id":"d1","_source":{"name":"changed","n":1,"note":"x"}}\n'),
      mode: 'stop',
      ids: 'keep',
      op: 'index',
    });
    expect(report.inserted).toBe(1);
    const doc = await callJson(session, { method: 'GET', path: `/${COPY}/_doc/d1` });
    expect(formatJsonLine(member(doc, '_source') ?? { type: 'null' })).toContain('"changed"');
    expect(await count(COPY)).toBe(DOCUMENTS);
  });

  it('makes up new ids when asked, adding every document once more', async () => {
    const text = await exported(SOURCE, 'documents');
    const report = await importIndex({
      session,
      index: COPY,
      chunks: chunks(text),
      mode: 'skip',
      ids: 'generate',
      op: 'create',
    });
    expect(report.inserted).toBe(DOCUMENTS);
    expect(await count(COPY)).toBe(DOCUMENTS * 2);
  });

  it('lists a document the mapping cannot take, on the line it was on', async () => {
    const report = await importIndex({
      session,
      index: SOURCE,
      chunks: chunks(
        '{"_id":"ok1","_source":{"name":"fine","n":1}}\n{"_id":"bad","_source":{"name":"x","n":"not a number"}}\n{"_id":"ok2","_source":{"name":"fine","n":2}}\n',
      ),
      mode: 'skip',
      ids: 'keep',
      op: 'index',
    });
    expect(report).toMatchObject({ inserted: 2, refused: 1, stopped: false });
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]?.line).toBe(2);
    expect(report.problems[0]?.message).toContain('parsing_exception');
    await session.request({ method: 'DELETE', path: `/${SOURCE}/_doc/ok1?refresh=true` });
    await session.request({ method: 'DELETE', path: `/${SOURCE}/_doc/ok2?refresh=true` });
  });

  it('round-trips the bulk format into a fresh index', async () => {
    const text = await exported(SOURCE, 'bulk');
    expect(text.split('\n')[0]).toMatch(/^\{"index":\{"_id":"d\d+"\}\}$/u);
    await createIndex(session, BULK_COPY, '');
    const report = await importIndex({
      session,
      index: BULK_COPY,
      chunks: chunks(text),
      mode: 'stop',
      ids: 'keep',
      op: 'index',
    });
    expect(report).toMatchObject({ inserted: DOCUMENTS, refused: 0 });
    expect(await count(BULK_COPY)).toBe(DOCUMENTS);
  });

  it('refuses an index that does not exist, with the server own message', async () => {
    await expect(exported('datanest-it-files-missing', 'documents')).rejects.toMatchObject({
      code: 'not-found',
    });
  });

  it('stops an export when cancelled, and leaves no scroll behind', async () => {
    const abort = new AbortController();
    const sink = new MemorySink();
    const result = await exportIndex({
      session,
      index: SOURCE,
      format: 'documents',
      sink,
      signal: abort.signal,
      onProgress: () => {
        abort.abort();
      },
    });
    expect(result.cancelled).toBe(true);
    expect(result.documents).toBeLessThan(DOCUMENTS);
    const stats = await callJson(session, { method: 'GET', path: '/_nodes/stats/indices/search' });
    const nodes = member(stats, 'nodes');
    const open = nodes?.type === 'object' ? nodes.members : [];
    for (const [, node] of open) {
      const scrolls = member(member(member(node, 'indices'), 'search'), 'scroll_current');
      expect(jsonNumberText(scrolls)).toBe('0');
    }
  });
});
