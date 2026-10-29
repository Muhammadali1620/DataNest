import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseShellStatement } from '../../../src/core/mongo/shell-command';
import { formatValue } from '../../../src/core/mongo/shell-format';
import { splitShellStatements } from '../../../src/core/mongo/shell-statements';
import { doc, int32 } from '../../../src/core/mongo/value';
import { driver } from '../../../src/drivers/mongodb';
import type { MongoSession } from '../../../src/drivers/mongo-driver';
import { type RunOutcome, runStatement } from '../../../src/services/mongodb/shell-run';
import { MongoResultModel } from '../../../src/vscode/panels/mongo-result-model';
import { TEST_MONGO } from '../../helpers/mongo-servers';

// docker/compose.yml `mongodb` (V7.7): statements of a query editor on a real server.
const SCRATCH = 'datanest_it_shell';
let session: MongoSession;

async function run(text: string, database = 'shop'): Promise<RunOutcome> {
  return await runStatement(session, database, parseShellStatement(text), { maxTimeMS: 5000 });
}

/** What an outcome shows, one document per line. */
async function shown(outcome: RunOutcome, count = 10): Promise<string[]> {
  switch (outcome.kind) {
    case 'cursor':
      return (await outcome.cursor.next(count)).documents.map((raw) => formatValue(raw.document));
    case 'documents':
      return outcome.documents.map((document) => formatValue(document));
    case 'count':
      return [outcome.count];
    case 'write':
      return [formatValue(outcome.reply)];
    case 'use':
      return [outcome.database];
  }
}

beforeAll(async () => {
  session = await driver.openSession({
    id: 'it',
    name: 'it',
    driver: 'mongodb',
    host: TEST_MONGO.host,
    port: TEST_MONGO.port,
    user: TEST_MONGO.user.name,
    password: TEST_MONGO.user.password,
  });
  await session.command(SCRATCH, doc([['dropDatabase', int32(1)]]));
});

afterAll(async () => {
  await session.command(SCRATCH, doc([['dropDatabase', int32(1)]]));
  await session.close();
});

describe('reading statements (V7.7)', () => {
  it('runs a find with its chain and a pipeline on the seed', async () => {
    expect(
      await shown(
        await run(
          'db.orders.find({ status: "shipped" }, { status: 1 }).sort({ _id: -1 }).skip(1).limit(2)',
        ),
      ),
    ).toEqual(['{ _id: 244, status: "shipped" }', '{ _id: 240, status: "shipped" }']);
    expect(
      await shown(
        await run(
          'db.orders.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }, { $sort: { _id: 1 } }])',
        ),
      ),
    ).toEqual(['{ _id: "new", n: 188 }', '{ _id: "shipped", n: 62 }']);
    expect(
      await shown(await run('db.aggregate([{ $documents: [{ a: 1 }, { a: 2 }] }])', 'admin')),
    ).toEqual(['{ a: 1 }', '{ a: 2 }']);
  });

  it('counts, finds distinct values and one document', async () => {
    expect(await shown(await run('db.orders.countDocuments({ status: "new" })'))).toEqual(['188']);
    expect(await shown(await run('db.orders.find({ status: "new" }).count()'))).toEqual(['188']);
    expect(await shown(await run('db.orders.estimatedDocumentCount()'))).toEqual(['250']);
    expect(await shown(await run('db.customers.distinct("city")'))).toEqual([
      '{ value: "Helsinki" }',
      '{ value: "London" }',
      '{ value: "New York" }',
    ]);
    expect(
      await shown(await run('db.getCollection("customers").findOne({ _id: 1 }, { name: 1 })')),
    ).toEqual(['{ _id: 1, name: "Ada" }']);
  });

  it('lists, explains and runs commands, in the database getSiblingDB names', async () => {
    expect(await shown(await run('show dbs'))).toEqual(
      expect.arrayContaining([expect.stringContaining('name: "shop"')]),
    );
    expect(await shown(await run('show collections'))).toContain(
      '{ name: "big_orders", type: "view" }',
    );
    expect((await shown(await run('db.orders.getIndexes()'))).length).toBeGreaterThan(3);
    expect((await shown(await run('db.orders.find({ customer: 2 }).explain()')))[0]).toContain(
      'queryPlanner',
    );
    expect((await shown(await run('db.runCommand({ ping: 1 })')))[0]).toContain('ok: 1.0');
    expect(
      (await shown(await run('db.getSiblingDB("types").values.find({}, { int64: 1 })')))[0],
    ).toContain('NumberLong("9223372036854775807")');
  });

  it('pages through a result of more documents than one page', async () => {
    const outcome = await run('db.orders.find({}).sort({ _id: 1 })');
    const model = await MongoResultModel.open({
      connectionName: 'it',
      database: 'shop',
      statement: 'db.orders.find({}).sort({ _id: 1 })',
      outcome: outcome as Exclude<RunOutcome, { kind: 'use' }>,
      tookMs: 0,
      texts: { count: String, write: () => '', capped: String },
      pageSize: 100,
    });
    expect(model.state().more).toBe(true);
    const last = await model.page(200);
    expect(last.rows.map((row) => row.id)).toHaveLength(50);
    expect(last.total).toEqual({ count: '250', exact: true });
  });
});

describe('writing statements (V7.7)', () => {
  it('inserts, updates, replaces and deletes, saying what changed', async () => {
    const text = `
      db.items.insertMany([{ _id: 1, n: 1 }, { _id: 2, n: 2 }, { _id: 3, n: 3 }])
      db.items.updateMany({ n: { $gt: 1 } }, { $inc: { n: 10 } })
      db.items.updateOne({ _id: 9 }, { $set: { n: 9 } }, { upsert: true })
      db.items.replaceOne({ _id: 1 }, { n: 100 })
      db.items.deleteOne({ _id: 2 })
      db.items.find({}).sort({ _id: 1 })`;
    const outcomes: RunOutcome[] = [];
    for (const statement of splitShellStatements(text)) {
      outcomes.push(await run(statement.text, SCRATCH));
    }
    expect(outcomes.slice(0, 5)).toMatchObject([
      { kind: 'write', inserted: 3 },
      { kind: 'write', matched: 2, modified: 2 },
      { kind: 'write', matched: 0, upserted: 1 },
      { kind: 'write', matched: 1, modified: 1 },
      { kind: 'write', deleted: 1 },
    ]);
    const last = outcomes[5];
    expect(last === undefined ? [] : await shown(last)).toEqual([
      '{ _id: 1, n: 100 }',
      '{ _id: 3, n: 13 }',
      '{ _id: 9, n: 9 }',
    ]);
  });

  it('manages indexes and collections, and passes a write error on', async () => {
    await run('db.createCollection("logs", { capped: true, size: 65536 })', SCRATCH);
    await run('db.logs.createIndex({ at: -1 }, { name: "at_desc" })', SCRATCH);
    expect((await shown(await run('db.logs.getIndexes()', SCRATCH))).join()).toContain('at_desc');
    await run('db.logs.dropIndex("at_desc")', SCRATCH);
    await expect(run('db.items.insertOne({ _id: 1 })', SCRATCH)).rejects.toMatchObject({
      code: 'constraint',
    });
    await run('db.logs.drop()', SCRATCH);
    expect(await shown(await run('db.getCollectionNames()', SCRATCH))).toEqual([
      '{ name: "items" }',
    ]);
  });
});
