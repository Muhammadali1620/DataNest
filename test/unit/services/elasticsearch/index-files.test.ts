import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { formatJsonLine, parseJson } from '../../../../src/core/json/json-tree';
import {
  BULK_BATCH,
  BULK_BODY_CHARS,
  createBodyOf,
  exportIndex,
  HEADER_KIND,
  importIndex,
  type IndexFileFormat,
  MAX_ARRAY_FILE_CHARS,
  MAX_REPORTED_PROBLEMS,
  READ_BATCH,
  readFileHeader,
  readIndexShape,
} from '../../../../src/services/elasticsearch/index-files';
import { json } from '../../../helpers/fake-elastic';
import { MemoryElastic, type StoredDocument } from '../../../helpers/memory-elastic';

class MemorySink {
  text = '';

  write(text: string): Promise<void> {
    this.text += text;
    return Promise.resolve();
  }

  get lines(): string[] {
    return this.text.split('\n').filter((line) => line !== '');
  }
}

async function* chunks(...parts: string[]): AsyncGenerator<{ text: string }> {
  for (const text of parts) {
    yield await Promise.resolve({ text });
  }
}

function docs(count: number): StoredDocument[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `d${index}`,
    source: `{"n":${index}}`,
  }));
}

async function exported(
  node: MemoryElastic,
  format: IndexFileFormat,
  extra: { signal?: AbortSignal; onProgress?: (count: number) => void } = {},
) {
  const sink = new MemorySink();
  const result = await exportIndex({
    session: node.session,
    index: node.index,
    format,
    sink,
    ...extra,
  });
  return { sink, result };
}

describe('exportIndex', () => {
  it('writes one {"_id","_source"} per line', async () => {
    const node = new MemoryElastic({
      documents: [
        { id: 'a', source: '{"name":"Ann"}' },
        { id: 'b', source: '{"name":"Bob"}' },
      ],
    });
    const { sink, result } = await exported(node, 'documents');
    expect(result).toEqual({ documents: 2, cancelled: false });
    expect(sink.lines).toEqual([
      '{"_id":"a","_source":{"name":"Ann"}}',
      '{"_id":"b","_source":{"name":"Bob"}}',
    ]);
  });

  it('keeps every digit of a number, trailing zero and size alike', async () => {
    const node = new MemoryElastic({
      documents: [{ id: 'n', source: '{"big":9007199254740993,"price":1.10,"tiny":1e-7}' }],
    });
    const { sink } = await exported(node, 'documents');
    expect(sink.text).toContain('"big":9007199254740993,"price":1.10,"tiny":1e-7');
  });

  it('puts the mappings and the settings a new index can take in a header', async () => {
    const node = new MemoryElastic({
      mappings: { properties: { name: { type: 'keyword' } } },
      documents: [{ id: 'a', source: '{"name":"Ann"}' }],
    });
    const { sink } = await exported(node, 'documents-with-mapping');
    const header = parseJson(sink.lines[0] ?? '');
    expect(formatJsonLine(header)).toBe(
      `{"datanest":"${HEADER_KIND}","version":1,"index":"shop","settings":{"index":{"number_of_shards":"1","number_of_replicas":"0"}},"mappings":{"properties":{"name":{"type":"keyword"}}}}`,
    );
    expect(sink.lines).toHaveLength(2);
  });

  it('writes bulk pairs: an action line and a source line', async () => {
    const node = new MemoryElastic({
      documents: [{ id: 'a', routing: 'r1', source: '{"x":1}' }, { source: '{"x":2}' }],
    });
    const { sink } = await exported(node, 'bulk');
    expect(sink.lines).toEqual([
      '{"index":{"_id":"a","routing":"r1"}}',
      '{"x":1}',
      '{"index":{"_id":"auto1"}}',
      '{"x":2}',
    ]);
  });

  it('keeps the routing of a document in the plain format too', async () => {
    const node = new MemoryElastic({ documents: [{ id: 'a', routing: 'r1', source: '{}' }] });
    const { sink } = await exported(node, 'documents');
    expect(sink.lines).toEqual(['{"_id":"a","_routing":"r1","_source":{}}']);
  });

  it('pages through more documents than one read holds', async () => {
    const node = new MemoryElastic({ documents: docs(READ_BATCH * 2 + 5) });
    const progress: number[] = [];
    const { sink, result } = await exported(node, 'documents', {
      onProgress: (count) => progress.push(count),
    });
    expect(result.documents).toBe(READ_BATCH * 2 + 5);
    expect(sink.lines).toHaveLength(READ_BATCH * 2 + 5);
    expect(progress).toEqual([READ_BATCH, READ_BATCH * 2, READ_BATCH * 2 + 5]);
    expect(node.scrollSizes).toEqual([READ_BATCH]);
  });

  it('exports an empty index as an empty file', async () => {
    const node = new MemoryElastic();
    const { sink, result } = await exported(node, 'documents');
    expect(result).toEqual({ documents: 0, cancelled: false });
    expect(sink.text).toBe('');
  });

  it('clears the scroll when it is done', async () => {
    const node = new MemoryElastic({ documents: docs(3) });
    await exported(node, 'documents');
    expect(node.deleted).toEqual(['scroll-1']);
  });

  it('stops when cancelled, after the page in hand, and clears the scroll', async () => {
    const node = new MemoryElastic({ documents: docs(READ_BATCH * 3) });
    const abort = new AbortController();
    const { result } = await exported(node, 'documents', {
      signal: abort.signal,
      onProgress: () => {
        abort.abort();
      },
    });
    expect(result).toEqual({ documents: READ_BATCH, cancelled: true });
    expect(node.deleted).toEqual(['scroll-1']);
  });

  it('refuses an index that keeps no source', async () => {
    const node = new MemoryElastic({ documents: docs(1), noSource: true });
    await expect(exported(node, 'documents')).rejects.toMatchObject({ code: 'unsupported' });
    expect(node.deleted).toEqual(['scroll-1']);
  });

  it('turns a server refusal into an error', async () => {
    const node = new MemoryElastic();
    const failing = new MemoryElastic({ documents: docs(1) });
    failing.session.request = () =>
      Promise.resolve(
        json(
          { error: { type: 'index_not_found_exception', reason: 'no such index' }, status: 404 },
          404,
        ),
      );
    await expect(
      exportIndex({
        session: failing.session,
        index: 'gone',
        format: 'documents',
        sink: new MemorySink(),
      }),
    ).rejects.toBeInstanceOf(DbError);
    expect(node.scrollSizes).toEqual([]);
  });

  it('asks for the index by its encoded name', async () => {
    const node = new MemoryElastic({ index: 'a b' });
    await exported(node, 'documents');
    expect(node.session.requests[0]).toContain('POST /a%20b/_search?scroll=');
  });
});

describe('readIndexShape', () => {
  it('drops the settings the server sets itself', async () => {
    const node = new MemoryElastic({
      mappings: { properties: { a: { type: 'text' } } },
    });
    const shape = await readIndexShape(node.session, node.index);
    expect(formatJsonLine(shape.settings)).toBe(
      '{"index":{"number_of_shards":"1","number_of_replicas":"0"}}',
    );
    expect(formatJsonLine(shape.mappings)).toBe('{"properties":{"a":{"type":"text"}}}');
  });

  it('falls back to empty mappings and settings', async () => {
    const node = new MemoryElastic({ mappings: undefined, settings: {} });
    const shape = await readIndexShape(node.session, node.index);
    expect(formatJsonLine(shape.settings)).toBe('{"index":{}}');
  });
});

describe('readFileHeader', () => {
  const header = `{"datanest":"${HEADER_KIND}","version":1,"index":"shop","settings":{"index":{"number_of_shards":"2"}},"mappings":{"properties":{"a":{"type":"long"}}}}`;

  it('reads the shape of the index the file came from', async () => {
    const found = await readFileHeader(chunks(`${header}\n{"_id":"a","_source":{}}\n`));
    expect(found?.index).toBe('shop');
    expect(createBodyOf(found)).toBe(
      '{"settings":{"index":{"number_of_shards":"2"}},"mappings":{"properties":{"a":{"type":"long"}}}}',
    );
  });

  it('reads a header split between two chunks', async () => {
    const found = await readFileHeader(chunks(header.slice(0, 40), `${header.slice(40)}\n`));
    expect(found?.index).toBe('shop');
  });

  it('is undefined for a file of plain documents, an array, bad text, or nothing', async () => {
    expect(await readFileHeader(chunks('{"a":1}\n'))).toBeUndefined();
    expect(await readFileHeader(chunks('[{"a":1}]'))).toBeUndefined();
    expect(await readFileHeader(chunks('oops\n'))).toBeUndefined();
    expect(await readFileHeader(chunks(''))).toBeUndefined();
    expect(await readFileHeader(chunks('\n\n'))).toBeUndefined();
  });

  it('is undefined for a header of another kind', async () => {
    expect(await readFileHeader(chunks('{"datanest":"redis-keys","version":1}\n'))).toBeUndefined();
  });

  it('makes the default index from no header, or one without a shape', () => {
    expect(createBodyOf(undefined)).toBe('');
    expect(createBodyOf({ index: 'x' })).toBe('');
  });
});

describe('importIndex', () => {
  const base = { mode: 'skip', ids: 'keep', op: 'index' } as const;

  it('sends documents in the format written by the export', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks(
        '{"_id":"a","_source":{"name":"Ann"}}\n{"_id":"b","_source":{"name":"Bob"}}\n',
      ),
    });
    expect(report).toMatchObject({ inserted: 2, refused: 0, cancelled: false, stopped: false });
    expect(node.bulks).toEqual([
      '{"index":{"_id":"a"}}\n{"name":"Ann"}\n{"index":{"_id":"b"}}\n{"name":"Bob"}\n',
    ]);
    expect(node.session.requests.some((line) => line.startsWith('POST /shop/_bulk'))).toBe(true);
  });

  it('refreshes the index at the end, so the documents can be found', async () => {
    const node = new MemoryElastic();
    await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"a":1}\n'),
    });
    expect(node.refreshed).toBe(1);
  });

  it('takes the pairs of a bulk file and their ids and routing', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"index":{"_id":"a","routing":"r1"}}\n{"x":1}\n{"create":{}}\n{"x":2}\n'),
    });
    expect(report.inserted).toBe(2);
    expect(node.bulks[0]).toBe(
      '{"index":{"_id":"a","routing":"r1"}}\n{"x":1}\n{"index":{}}\n{"x":2}\n',
    );
  });

  it('takes plain documents with ids made up by the server', async () => {
    const node = new MemoryElastic();
    await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"x":1}\n{"y":{"index":1}}\n'),
    });
    expect(node.bulks[0]).toBe('{"index":{}}\n{"x":1}\n{"index":{}}\n{"y":{"index":1}}\n');
  });

  it('reads a document that is nothing but an "index" member as an action line', async () => {
    // The one ambiguity of the format: `{"index":{…}}` alone on a line is a `_bulk` action.
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"index":{"a":1}}\n'),
    });
    expect(report.inserted).toBe(0);
    expect(report.problems).toEqual([
      { line: 1, message: 'The action line has no document after it' },
    ]);
  });

  it('reads a JSON array', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('[{"x":1},', '{"_id":"k","_source":{"x":2}}]'),
    });
    expect(report.inserted).toBe(2);
    expect(node.bulks[0]).toBe('{"index":{}}\n{"x":1}\n{"index":{"_id":"k"}}\n{"x":2}\n');
  });

  it('drops the ids of the file when asked to make up new ones', async () => {
    const node = new MemoryElastic();
    await importIndex({
      ...base,
      ids: 'generate',
      op: 'create',
      session: node.session,
      index: 'shop',
      chunks: chunks('{"_id":"a","_routing":"r","_source":{"x":1}}\n'),
    });
    expect(node.bulks[0]).toBe('{"create":{"routing":"r"}}\n{"x":1}\n');
  });

  it('keeps every digit of a number on the way in', async () => {
    const node = new MemoryElastic();
    await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"_id":"n","_source":{"big":9007199254740993,"price":1.10}}\n'),
    });
    expect(node.bulks[0]).toContain('{"big":9007199254740993,"price":1.10}');
  });

  it('puts a number id in as text', async () => {
    const node = new MemoryElastic();
    await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"_id":42,"_source":{"x":1}}\n'),
    });
    expect(node.bulks[0]).toBe('{"index":{"_id":"42"}}\n{"x":1}\n');
  });

  it('refuses a document that exists when it is told to create, and lists its line', async () => {
    const node = new MemoryElastic({ documents: [{ id: 'a', source: '{"old":true}' }] });
    const report = await importIndex({
      ...base,
      op: 'create',
      session: node.session,
      index: 'shop',
      chunks: chunks('{"_id":"a","_source":{"x":1}}\n\n{"_id":"b","_source":{"x":2}}\n'),
    });
    expect(report.inserted).toBe(1);
    expect(report.refused).toBe(1);
    expect(report.problems).toEqual([
      { line: 1, message: 'version_conflict_engine_exception: [a]: version conflict' },
    ]);
    expect(node.stored.find((document) => document.id === 'a')?.source).toBe('{"old":true}');
  });

  it('replaces a document that exists when it is told to index', async () => {
    const node = new MemoryElastic({ documents: [{ id: 'a', source: '{"old":true}' }] });
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"_id":"a","_source":{"x":1}}\n'),
    });
    expect(report.inserted).toBe(1);
    expect(node.stored[0]?.source).toBe('{"x":1}');
  });

  it('skips a refused document and goes on in skip mode', async () => {
    const node = new MemoryElastic({
      refuse: (_action, _id, source) =>
        source.includes('"bad"')
          ? { status: 400, type: 'mapper_parsing_exception', reason: 'cannot parse' }
          : undefined,
    });
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"ok":1}\n{"bad":1}\n{"ok":2}\n'),
    });
    expect(report).toMatchObject({ inserted: 2, refused: 1, stopped: false });
    expect(report.problems).toEqual([
      { line: 2, message: 'mapper_parsing_exception: cannot parse' },
    ]);
  });

  it('stops after the batch with a refused document in stop mode and sends no more', async () => {
    const node = new MemoryElastic({
      refuse: (_action, _id, source) =>
        source.includes('"bad"') ? { status: 400, type: 't', reason: 'r' } : undefined,
    });
    const lines = Array.from({ length: BULK_BATCH + 10 }, (_, index) =>
      index === 2 ? '{"bad":1}' : `{"n":${index}}`,
    );
    const report = await importIndex({
      ...base,
      mode: 'stop',
      session: node.session,
      index: 'shop',
      chunks: chunks(`${lines.join('\n')}\n`),
    });
    expect(report.stopped).toBe(true);
    expect(report.inserted).toBe(BULK_BATCH - 1);
    expect(report.refused).toBe(1);
    expect(report.problems).toEqual([{ line: 3, message: 't: r' }]);
    // The batch is sent whole, as _bulk is not ordered; the batch after it never leaves.
    expect(node.bulks).toHaveLength(1);
    expect(node.stored).toHaveLength(BULK_BATCH - 1);
  });

  it('stops at a line that is not JSON in stop mode, keeping what came before', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      mode: 'stop',
      session: node.session,
      index: 'shop',
      chunks: chunks('{"ok":1}\noops\n{"ok":2}\n'),
    });
    expect(report).toMatchObject({ inserted: 1, refused: 1, stopped: true });
    expect(report.problems[0]?.line).toBe(2);
  });

  it('lists a line that is not JSON and goes on in skip mode', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"ok":1}\r\noops\r\n3\r\n{"ok":2}'),
    });
    expect(report.inserted).toBe(2);
    expect(report.problems.map((problem) => problem.line)).toEqual([2, 3]);
    expect(report.problems[1]?.message).toMatch(/object/);
  });

  it('refuses update and delete actions of a bulk file', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"delete":{"_id":"a"}}\n{"index":{}}\n{"x":1}\n'),
    });
    expect(report.inserted).toBe(1);
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toMatchObject({ line: 1 });
    expect(report.problems[0]?.message).toContain('delete');
  });

  it('reports an action line that has no document after it', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"x":1}\n{"index":{"_id":"a"}}\n'),
    });
    expect(report.inserted).toBe(1);
    expect(report.problems).toEqual([
      { line: 2, message: 'The action line has no document after it' },
    ]);
  });

  it('passes over the header line', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks(
        `{"datanest":"${HEADER_KIND}","version":1,"index":"x"}\n{"_id":"a","_source":{"x":1}}\n`,
      ),
    });
    expect(report).toMatchObject({ inserted: 1, refused: 0 });
  });

  it('sends the documents in batches', async () => {
    const node = new MemoryElastic();
    const lines = Array.from({ length: BULK_BATCH * 2 + 7 }, (_, index) => `{"n":${index}}`);
    const progress: number[] = [];
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks(`${lines.join('\n')}\n`),
      onProgress: (count) => progress.push(count),
    });
    expect(report.inserted).toBe(BULK_BATCH * 2 + 7);
    expect(node.bulks).toHaveLength(3);
    expect(progress).toEqual([BULK_BATCH, BULK_BATCH * 2, BULK_BATCH * 2 + 7]);
  });

  it('cuts a batch of big documents by size, not only by count', async () => {
    const node = new MemoryElastic();
    const big = JSON.stringify({ text: 'x'.repeat(BULK_BODY_CHARS / 2 + 10) });
    await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks(`${big}\n${big}\n${big}\n`),
    });
    expect(node.bulks.length).toBeGreaterThan(1);
    expect(node.stored).toHaveLength(3);
  });

  it('reads lines cut anywhere between chunks', async () => {
    const node = new MemoryElastic();
    const text =
      '{"_id":"a","_source":{"name":"Ann Ünal"}}\n{"_id":"b","_source":{"name":"Bob"}}\n';
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks(...(text.match(/.{1,7}/gsu) ?? [])),
    });
    expect(report.inserted).toBe(2);
    expect(node.stored[0]?.source).toBe('{"name":"Ann Ünal"}');
  });

  it('stops when cancelled and says so', async () => {
    const node = new MemoryElastic();
    const abort = new AbortController();
    async function* slow(): AsyncGenerator<{ text: string }> {
      yield await Promise.resolve({ text: '{"a":1}\n' });
      abort.abort();
      yield await Promise.resolve({ text: '{"a":2}\n' });
    }
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: slow(),
      signal: abort.signal,
    });
    expect(report.cancelled).toBe(true);
    expect(report.inserted).toBe(1);
  });

  it('counts the refused documents past the ones it lists', async () => {
    const node = new MemoryElastic();
    const lines = Array.from({ length: MAX_REPORTED_PROBLEMS + 20 }, () => 'oops').join('\n');
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks(lines),
    });
    expect(report.refused).toBe(MAX_REPORTED_PROBLEMS + 20);
    expect(report.problems).toHaveLength(MAX_REPORTED_PROBLEMS);
  });

  it('refuses a JSON array too large to read whole', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('[', 'x'.repeat(MAX_ARRAY_FILE_CHARS + 1)),
    });
    expect(report.stopped).toBe(false);
    expect(report.refused).toBe(1);
    expect(report.problems[0]?.message).toMatch(/one document per line/);
  });

  it('reports a JSON array that does not parse', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('[{"a":1},'),
    });
    expect(report.refused).toBe(1);
    expect(report.problems[0]?.line).toBe(1);
  });

  it('is an empty report for an empty file', async () => {
    const node = new MemoryElastic();
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks(''),
    });
    expect(report).toMatchObject({ inserted: 0, refused: 0, cancelled: false });
    expect(node.bulks).toEqual([]);
  });

  it('throws when the server refuses the whole request', async () => {
    const node = new MemoryElastic({
      bulkAnswer: () =>
        json(
          { error: { type: 'es_rejected_execution_exception', reason: 'queue full' }, status: 429 },
          429,
        ),
    });
    await expect(
      importIndex({ ...base, session: node.session, index: 'shop', chunks: chunks('{"a":1}\n') }),
    ).rejects.toBeInstanceOf(DbError);
  });

  it('counts an item with no status in the reply as taken, and survives an unreadable reply', async () => {
    const node = new MemoryElastic({ bulkAnswer: () => json('not json') });
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"a":1}\n'),
    });
    expect(report.inserted).toBe(1);
  });

  it('keeps going when the final refresh fails', async () => {
    const node = new MemoryElastic();
    const original = node.session.request.bind(node.session);
    node.session.request = async (request) => {
      if (request.path.endsWith('/_refresh')) {
        throw new DbError('connection-failed', 'gone');
      }
      return await original(request);
    };
    const report = await importIndex({
      ...base,
      session: node.session,
      index: 'shop',
      chunks: chunks('{"a":1}\n'),
    });
    expect(report.inserted).toBe(1);
  });

  it('round-trips an exported index into another one', async () => {
    const from = new MemoryElastic({
      documents: [
        { id: 'a', routing: 'r', source: '{"big":9007199254740993,"tags":["x","y"]}' },
        { id: 'b', source: '{"nested":{"k":null}}' },
      ],
    });
    const { sink } = await exported(from, 'documents-with-mapping');
    const to = new MemoryElastic({ index: 'copy' });
    const report = await importIndex({
      ...base,
      session: to.session,
      index: 'copy',
      chunks: chunks(sink.text),
    });
    expect(report.inserted).toBe(2);
    expect(to.stored).toEqual([
      { id: 'a', routing: 'r', source: '{"big":9007199254740993,"tags":["x","y"]}' },
      { id: 'b', source: '{"nested":{"k":null}}' },
    ]);
  });

  it('round-trips the bulk format too', async () => {
    const from = new MemoryElastic({ documents: [{ id: 'a', source: '{"x":1}' }] });
    const { sink } = await exported(from, 'bulk');
    const to = new MemoryElastic({ index: 'copy' });
    await importIndex({ ...base, session: to.session, index: 'copy', chunks: chunks(sink.text) });
    expect(to.stored).toEqual([{ id: 'a', source: '{"x":1}' }]);
  });
});
