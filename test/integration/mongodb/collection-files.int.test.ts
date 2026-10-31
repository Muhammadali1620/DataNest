// Exporting a collection to a file and importing it back (V10.2.7) on a real MongoDB:
// every BSON type returns as it was, a mongoexport-style relaxed file loads, and a
// duplicate _id stops or is skipped as asked.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseDocument } from '../../../src/core/mongo/shell-parse';
import { doc, int32, type MongoDocument } from '../../../src/core/mongo/value';
import { driver } from '../../../src/drivers/mongodb';
import type { MongoSession } from '../../../src/drivers/mongo-driver';
import { FileSink } from '../../../src/services/file-sink';
import { exportCollection, importCollection } from '../../../src/services/mongodb/collection-files';
import { readTextChunks } from '../../../src/services/text-file';
import { TEST_MONGO } from '../../helpers/mongo-servers';

const DATABASE = 'datanest_it_files';
let session: MongoSession;
let dir: string;

async function all(collection: string): Promise<MongoDocument[]> {
  const cursor = await session.openCursor(DATABASE, {
    kind: 'find',
    collection,
    sort: doc([['_id', int32(1)]]),
  });
  const found: MongoDocument[] = [];
  for (;;) {
    const batch = await cursor.next(1000);
    found.push(...batch.documents.map((raw) => raw.document));
    if (batch.done) {
      await cursor.close();
      return found;
    }
  }
}

beforeAll(async () => {
  session = await driver.openSession({
    id: 'files',
    name: 'files',
    driver: 'mongodb',
    host: TEST_MONGO.host,
    port: TEST_MONGO.port,
    user: TEST_MONGO.user.name,
    password: TEST_MONGO.user.password,
  });
  await session.command(DATABASE, doc([['dropDatabase', int32(1)]]));
  dir = mkdtempSync(join(tmpdir(), 'datanest-mongo-files-'));
});

afterAll(async () => {
  await session.command(DATABASE, doc([['dropDatabase', int32(1)]]));
  await session.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('collection files', () => {
  it('exports every type and imports it back unchanged', async () => {
    const original = [
      parseDocument(
        `{ _id: 1, i: 7, l: NumberLong("9007199254740993"), d: 1.5, dec: NumberDecimal("1.10"),
           s: "текст", b: true, n: null, at: ISODate("2024-01-02T03:04:05.006Z"),
           oid: ObjectId("507f1f77bcf86cd799439011"), bin: BinData(0, "AAECAw=="),
           re: /^a.*/i, list: [1, "two", { x: 1 }], nested: { "12": 1, a: 2 } }`,
      ),
      parseDocument(
        '{ _id: 2, nan: NaN, inf: -Infinity, ts: Timestamp(1700000000, 3), min: MinKey(), max: MaxKey() }',
      ),
    ];
    await session.command(
      DATABASE,
      doc([
        ['insert', { type: 'string', value: 'source' }],
        ['documents', { type: 'array', items: original }],
      ]),
    );
    const file = join(dir, 'source.json');
    const sink = await FileSink.create(file);
    expect(
      await exportCollection({ session, database: DATABASE, collection: 'source', sink }),
    ).toEqual({
      documents: 2,
      cancelled: false,
    });
    await sink.close();
    expect(readFileSync(file, 'utf8').split('\n')[0]).toContain(
      '"l":{"$numberLong":"9007199254740993"}',
    );
    const report = await importCollection({
      session,
      database: DATABASE,
      collection: 'copy',
      chunks: readTextChunks(file),
      mode: 'stop',
    });
    expect(report).toMatchObject({ inserted: 2, refused: 0, stopped: false });
    expect(await all('copy')).toEqual(await all('source'));
  });

  it('loads a relaxed file as mongoexport writes it', async () => {
    const file = join(dir, 'relaxed.json');
    const sink = await FileSink.create(file);
    await sink.write(
      '{"_id":{"$oid":"5f0000000000000000000001"},"qty":5,"big":3000000000,"price":9.99,"at":{"$date":"2024-05-06T07:08:09Z"}}\n',
    );
    await sink.close();
    const report = await importCollection({
      session,
      database: DATABASE,
      collection: 'relaxed',
      chunks: readTextChunks(file),
      mode: 'stop',
    });
    expect(report.inserted).toBe(1);
    const [stored] = await all('relaxed');
    expect(stored?.fields.map(([name, value]) => [name, value.type])).toEqual([
      ['_id', 'objectId'],
      ['qty', 'int32'],
      ['big', 'int64'],
      ['price', 'double'],
      ['at', 'date'],
    ]);
  });

  it('stops at a duplicate _id, or skips it and goes on', async () => {
    const file = join(dir, 'dupes.json');
    const sink = await FileSink.create(file);
    await sink.write('{"_id":1}\n{"_id":2}\n{"_id":1}\n{"_id":3}\n');
    await sink.close();
    const stopped = await importCollection({
      session,
      database: DATABASE,
      collection: 'dupes_stop',
      chunks: readTextChunks(file),
      mode: 'stop',
    });
    expect(stopped).toMatchObject({ inserted: 2, refused: 1, stopped: true });
    expect(stopped.problems[0]).toMatchObject({
      line: 3,
      message: expect.stringContaining('duplicate key') as unknown,
    });
    expect((await all('dupes_stop')).length).toBe(2);
    const skipped = await importCollection({
      session,
      database: DATABASE,
      collection: 'dupes_skip',
      chunks: readTextChunks(file),
      mode: 'skip',
    });
    expect(skipped).toMatchObject({ inserted: 3, refused: 1, stopped: false });
    expect((await all('dupes_skip')).length).toBe(3);
  });
});
