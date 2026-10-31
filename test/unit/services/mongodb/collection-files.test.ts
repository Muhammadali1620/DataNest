import { describe, expect, it } from 'vitest';
import {
  doc,
  int32,
  type MongoDocument,
  type MongoValue,
  str,
} from '../../../../src/core/mongo/value';
import {
  exportCollection,
  importCollection,
  INSERT_BATCH,
  MAX_ARRAY_FILE_CHARS,
  MAX_REPORTED_PROBLEMS,
} from '../../../../src/services/mongodb/collection-files';
import { FakeMongoSession } from '../../../helpers/fake-mongo';

function documents(count: number): MongoDocument[] {
  return Array.from({ length: count }, (_, index) =>
    doc([
      ['_id', int32(index)],
      ['name', str(`n${index}`)],
    ]),
  );
}

class MemorySink {
  text = '';

  write(text: string): Promise<void> {
    this.text += text;
    return Promise.resolve();
  }
}

async function* chunks(...parts: string[]): AsyncGenerator<{ text: string }> {
  for (const text of parts) {
    yield await Promise.resolve({ text });
  }
}

/** A session that records the documents of each insert and answers with `writeErrors`. */
function recording(
  writeErrors?: (batch: readonly MongoValue[]) => { index: number; message: string }[],
): FakeMongoSession & { inserted: MongoValue[][] } {
  const inserted: MongoValue[][] = [];
  const session = new FakeMongoSession((_database, command) => {
    const items = command.fields.find(([name]) => name === 'documents')?.[1];
    const batch = items?.type === 'array' ? items.items : [];
    inserted.push([...batch]);
    const errors = writeErrors?.(batch) ?? [];
    return doc([
      ['n', int32(batch.length - errors.length)],
      ...(errors.length === 0
        ? []
        : [
            [
              'writeErrors',
              {
                type: 'array',
                items: errors.map((error) =>
                  doc([
                    ['index', int32(error.index)],
                    ['code', int32(11000)],
                    ['errmsg', str(error.message)],
                  ]),
                ),
              },
            ] as const,
          ]),
      ['ok', { type: 'double', value: '1' }],
    ]);
  });
  return Object.assign(session, { inserted });
}

function inserts(session: { inserted: MongoValue[][] }): MongoValue[][] {
  return session.inserted;
}

describe('exportCollection', () => {
  it('writes every document as canonical Extended JSON, one per line', async () => {
    const session = new FakeMongoSession();
    session.documents.set('shop.items', documents(1203));
    const sink = new MemorySink();
    const progress: number[] = [];
    const result = await exportCollection({
      session,
      database: 'shop',
      collection: 'items',
      sink,
      onProgress: (count) => progress.push(count),
    });
    expect(result).toEqual({ documents: 1203, cancelled: false });
    const lines = sink.text.trimEnd().split('\n');
    expect(lines).toHaveLength(1203);
    expect(lines[0]).toBe('{"_id":{"$numberInt":"0"},"name":"n0"}');
    expect(sink.text.endsWith('\n')).toBe(true);
    expect(progress.at(-1)).toBe(1203);
    expect(session.cursors[0]).toEqual({
      database: 'shop',
      request: { kind: 'find', collection: 'items' },
    });
  });

  it('writes an empty file for an empty collection', async () => {
    const sink = new MemorySink();
    expect(
      await exportCollection({
        session: new FakeMongoSession(),
        database: 'd',
        collection: 'c',
        sink,
      }),
    ).toEqual({
      documents: 0,
      cancelled: false,
    });
    expect(sink.text).toBe('');
  });

  it('stops when cancelled', async () => {
    const session = new FakeMongoSession();
    session.documents.set('d.c', documents(2000));
    const abort = new AbortController();
    const result = await exportCollection({
      session,
      database: 'd',
      collection: 'c',
      sink: new MemorySink(),
      signal: abort.signal,
      onProgress: () => {
        abort.abort();
      },
    });
    expect(result).toEqual({ documents: 500, cancelled: true });
  });
});

describe('importCollection', () => {
  it('inserts the documents of every line in batches, even across pieces of the file', async () => {
    const session = recording();
    const lines = Array.from(
      { length: INSERT_BATCH + 3 },
      (_, index) => `{"_id":${index},"v":{"$numberLong":"5"}}`,
    );
    const text = `${lines.join('\r\n')}\r\n\r\n`;
    const report = await importCollection({
      session,
      database: 'shop',
      collection: 'items',
      chunks: chunks(text.slice(0, 1000), text.slice(1000, 1001), text.slice(1001)),
      mode: 'stop',
    });
    expect(report).toEqual({
      inserted: INSERT_BATCH + 3,
      refused: 0,
      problems: [],
      cancelled: false,
      stopped: false,
    });
    expect(inserts(session).map((batch) => batch.length)).toEqual([INSERT_BATCH, 3]);
    expect(inserts(session)[0]?.[0]).toEqual(
      doc([
        ['_id', int32(0)],
        ['v', { type: 'int64', value: '5' }],
      ]),
    );
    expect(session.commands[0]).toContain('ordered: true');
  });

  it('reads a last line that has no newline', async () => {
    const session = recording();
    const report = await importCollection({
      session,
      database: 'd',
      collection: 'c',
      chunks: chunks('{"a":1}\n{"a":2}'),
      mode: 'skip',
    });
    expect(report.inserted).toBe(2);
    expect(session.commands[0]).toContain('ordered: false');
  });

  it('skips lines that are not documents and refused documents, listing their lines', async () => {
    const session = recording((batch) =>
      batch.length > 1 ? [{ index: 1, message: 'E11000 duplicate key' }] : [],
    );
    const report = await importCollection({
      session,
      database: 'd',
      collection: 'c',
      chunks: chunks('{"_id":1}\n{broken\n{"_id":1}\n[1,2]\n{"_id":2}\n'),
      mode: 'skip',
    });
    expect(report).toMatchObject({ inserted: 2, refused: 3, stopped: false });
    expect(report.problems.map((problem) => problem.line)).toEqual([2, 4, 3]);
    expect(report.problems[2]?.message).toBe('E11000 duplicate key');
  });

  it('stops at the first problem in stop mode, keeping what came before', async () => {
    const session = recording();
    const report = await importCollection({
      session,
      database: 'd',
      collection: 'c',
      chunks: chunks('{"a":1}\n{"a":2}\n{"$oid":"bad"}\n{"a":4}\n'),
      mode: 'stop',
    });
    expect(report).toMatchObject({ inserted: 2, refused: 1, stopped: true });
    expect(report.problems).toEqual([
      { line: 3, message: expect.stringMatching(/ObjectId/u) as unknown },
    ]);
  });

  it('stops after a document the server refused in stop mode', async () => {
    const session = recording(() => [{ index: 0, message: 'refused' }]);
    const report = await importCollection({
      session,
      database: 'd',
      collection: 'c',
      chunks: chunks(Array.from({ length: INSERT_BATCH * 2 }, () => '{"a":1}').join('\n')),
      mode: 'stop',
    });
    expect(report).toMatchObject({ refused: 1, stopped: true });
    expect(inserts(session)).toHaveLength(1);
  });

  it('reads a JSON array, as mongoexport --jsonArray writes', async () => {
    const session = recording();
    const report = await importCollection({
      session,
      database: 'd',
      collection: 'c',
      chunks: chunks('  [{"a":1},', '{"a":{"$date":"2024-01-01T00:00:00Z"}}]'),
      mode: 'stop',
    });
    expect(report.inserted).toBe(2);
    expect(inserts(session)[0]?.[1]).toEqual(
      doc([['a', { type: 'date', value: '1704067200000' }]]),
    );
  });

  it('refuses a broken JSON array, and one too large to read whole', async () => {
    const broken = await importCollection({
      session: recording(),
      database: 'd',
      collection: 'c',
      chunks: chunks('[{"a":1},'),
      mode: 'skip',
    });
    expect(broken).toMatchObject({ inserted: 0, stopped: true, problems: [{ line: 1 }] });
    const huge = await importCollection({
      session: recording(),
      database: 'd',
      collection: 'c',
      chunks: chunks('[', 'x'.repeat(MAX_ARRAY_FILE_CHARS)),
      mode: 'skip',
    });
    expect(huge.problems[0]?.message).toMatch(/one document per line/u);
  });

  it('lists only so many problems, but counts them all', async () => {
    const report = await importCollection({
      session: recording(),
      database: 'd',
      collection: 'c',
      chunks: chunks(Array.from({ length: MAX_REPORTED_PROBLEMS + 20 }, () => 'nope').join('\n')),
      mode: 'skip',
    });
    expect(report.refused).toBe(MAX_REPORTED_PROBLEMS + 20);
    expect(report.problems).toHaveLength(MAX_REPORTED_PROBLEMS);
  });

  it('stops reading when cancelled', async () => {
    const abort = new AbortController();
    abort.abort();
    const report = await importCollection({
      session: recording(),
      database: 'd',
      collection: 'c',
      chunks: chunks('{"a":1}\n'),
      mode: 'skip',
      signal: abort.signal,
    });
    expect(report).toMatchObject({ inserted: 0, cancelled: true });
  });

  it('inserts nothing from an empty file', async () => {
    const session = recording();
    expect(
      await importCollection({
        session,
        database: 'd',
        collection: 'c',
        chunks: chunks(''),
        mode: 'skip',
      }),
    ).toMatchObject({
      inserted: 0,
      refused: 0,
    });
    expect(inserts(session)).toEqual([]);
  });
});
