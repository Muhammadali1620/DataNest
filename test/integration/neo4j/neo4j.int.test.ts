import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/neo4j';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { ResultStore } from '../../../src/services/result-store';
import { TableViewer, tableDocumentUri } from '../../../src/services/table-view';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { TEST_NEO4J } from '../../helpers/neo4j-servers';

// docker/compose.yml `neo4j` (V13.21): the community server, its HTTP port, one sign-in.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'test-neo4j',
    name: 'neo4j',
    driver: 'neo4j',
    host: TEST_NEO4J.host,
    port: TEST_NEO4J.port,
    user: TEST_NEO4J.user,
    password: TEST_NEO4J.password,
    ...overrides,
  };
}

/** Runs a statement and keeps the error it ends with. */
async function failure(session: Session, cypher: string): Promise<DbError> {
  try {
    await runAll(session, cypher);
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error(`The statement did not fail: ${cypher}`);
}

const SEED = [
  "CREATE (a:Person {name: 'Ann', age: 30, born: date('1990-01-02'), big: 9007199254740993, tags: ['x', 'y']})",
  "CREATE (b:Person {name: 'Bob', age: 25})",
  "CREATE (c:City {name: 'Riga'})",
  'CREATE (a)-[:KNOWS {since: 2020}]->(b)',
  'CREATE (a)-[:LIVES_IN]->(c)',
].join('\n');

describe('neo4j driver on a Neo4j server', () => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config());
    await runAll(session, 'MATCH (n) DETACH DELETE n');
    await runAll(session, 'CREATE INDEX person_age IF NOT EXISTS FOR (p:Person) ON (p.age)');
    await runAll(
      session,
      'CREATE CONSTRAINT city_name IF NOT EXISTS FOR (c:City) REQUIRE c.name IS UNIQUE',
    );
    await runAll(session, SEED);
    await runAll(session, "UNWIND range(1, 25) AS i CREATE (:Item {n: i, label: 'item ' + i})");
  }, 60_000);

  afterAll(async () => {
    await runAll(session, 'MATCH (n) DETACH DELETE n');
    await runAll(session, 'DROP INDEX person_age IF EXISTS');
    await runAll(session, 'DROP CONSTRAINT city_name IF EXISTS');
    await session.close();
  });

  it('answers a query with typed columns', async () => {
    const result = await runAll(
      session,
      "RETURN 1 + 1 AS two, 'é' AS e, true AS yes, null AS nothing",
    );
    expect(result.columnSets[0]).toEqual([
      { name: 'two', dataType: 'integer' },
      { name: 'e', dataType: 'string' },
      { name: 'yes', dataType: 'boolean' },
      { name: 'nothing' },
    ]);
    expect(result.rows[0]).toEqual([2, 'é', true, null]);
  });

  it('keeps every kind of value exact', async () => {
    const result = await runAll(
      session,
      "MATCH (a:Person {name: 'Ann'}) RETURN a.big AS big, a.born AS born, 0.1 AS f, a.tags AS tags, {k: 'v', n: 9007199254740993} AS m, point({x: 1, y: 2}) AS p, duration('P1D') AS d",
    );
    const [big, born, f, tags, map, point, duration] = result.rows[0] ?? [];
    expect(big).toEqual({ kind: 'bigint', text: '9007199254740993' });
    expect(born).toEqual({ kind: 'datetime', text: '1990-01-02' });
    expect(f).toBe(0.1);
    expect(tags).toEqual({ kind: 'json', text: '["x","y"]' });
    expect((map as { text: string }).text).toContain('"n":9007199254740993');
    expect(JSON.parse((map as { text: string }).text)).toMatchObject({ k: 'v' });
    expect(point).toMatch(/POINT \(1\.0 2\.0\)/u);
    expect(duration).toBe('P1D');
  });

  it('shows a node, a relationship and a path as JSON', async () => {
    const result = await runAll(
      session,
      "MATCH p = (a:Person {name: 'Ann'})-[r:KNOWS]->(b) RETURN a, r, p",
    );
    const [node, rel, path] = result.rows[0] ?? [];
    const parsed = JSON.parse((node as { text: string }).text) as {
      labels: string[];
      properties: Record<string, unknown>;
    };
    expect(parsed.labels).toEqual(['Person']);
    expect(parsed.properties.name).toBe('Ann');
    expect((node as { text: string }).text).toContain('"big":9007199254740993');
    const relation = JSON.parse((rel as { text: string }).text) as { type: string };
    expect(relation.type).toBe('KNOWS');
    expect(JSON.parse((path as { text: string }).text)).toHaveLength(3);
  });

  it('reports what a writing statement did', async () => {
    const result = await runAll(session, 'CREATE (:Temp {a: 1}), (:Temp {a: 2})');
    expect(result.columnSets).toEqual([]);
    expect(result.done.affectedRows).toBe(2);
    expect(result.done.notice).toContain('2');
    await runAll(session, 'MATCH (t:Temp) DELETE t');
  });

  it('cuts a result at the row limit', async () => {
    const result = await runAll(session, 'UNWIND range(1, 50) AS i RETURN i', { rowLimit: 7 });
    expect(firstColumn(result)).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });

  it('maps a syntax error, an unknown database and a wrong password', async () => {
    expect((await failure(session, 'RETRN 1')).code).toBe('syntax');
    const other = await driver.openSession(config({ database: 'neo4j' }));
    await other.close();
    await expect(driver.openSession(config({ database: 'nosuchdb' }))).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(driver.openSession(config({ password: 'nope' }))).rejects.toMatchObject({
      code: 'auth-failed',
    });
  });

  it('fails to connect to a port nobody listens on', async () => {
    await expect(driver.openSession(config({ port: 7999 }))).rejects.toMatchObject({
      code: 'connection-failed',
    });
  });

  it('refuses writes on a read-only connection, in the server itself', async () => {
    const readOnly = await driver.openSession(config({ readOnly: true }));
    try {
      expect((await failure(readOnly, 'CREATE (:Nope)')).code).toBe('permission-denied');
      const result = await runAll(readOnly, 'MATCH (p:Person) RETURN count(p) AS c');
      expect(result.rows[0]?.[0]).toBe(2);
    } finally {
      await readOnly.close();
    }
  });

  it('cancels a statement that runs long', async () => {
    const running = failure(session, 'UNWIND range(1, 2000000000) AS x RETURN count(x)');
    await new Promise((resolve) => setTimeout(resolve, 400));
    await session.cancel();
    expect((await running).code).toBe('cancelled');
    // The session is usable afterwards.
    expect(firstColumn(await runAll(session, 'RETURN 5'))).toEqual([5]);
  }, 30_000);

  it('lists databases, labels and relationship types', async () => {
    expect(await session.metadata.listDatabases()).toEqual(
      expect.arrayContaining(['neo4j', 'system']),
    );
    const tables = await session.metadata.listTables({});
    expect(tables).toEqual(
      expect.arrayContaining([
        { name: 'Person', kind: 'table' },
        { name: 'City', kind: 'table' },
        { name: '[KNOWS]', kind: 'view' },
        { name: '[LIVES_IN]', kind: 'view' },
      ]),
    );
  });

  it('describes the property keys of a label and of a relationship type', async () => {
    const person = await session.metadata.listColumns({ name: 'Person' });
    expect(person.map((column) => column.name)).toEqual([
      '_id',
      '_labels',
      'age',
      'big',
      'born',
      'name',
      'tags',
    ]);
    // Both people have an age and a name, so the server calls them mandatory; only Ann has
    // the others.
    expect(person.find((column) => column.name === 'age')).toMatchObject({
      dataType: 'long',
      nullable: false,
    });
    expect(person.find((column) => column.name === 'big')?.nullable).toBe(true);
    const knows = await session.metadata.listColumns({ name: '[KNOWS]' });
    expect(knows.map((column) => column.name)).toEqual(['_id', '_type', '_from', '_to', 'since']);
  });

  it('lists the indexes and the constraints of a label', async () => {
    const indexes = await session.metadata.listIndexes({ name: 'Person' });
    expect(indexes).toEqual([
      expect.objectContaining({ name: 'person_age', columns: ['age'], unique: false }),
    ]);
    const city = await session.metadata.getDefinition({ kind: 'table', name: 'City' });
    expect(city).toHaveLength(1);
    expect(city[0]).toMatch(/CONSTRAINT `city_name`/u);
    const none = await session.metadata.getDefinition({ kind: 'table', name: 'Item' });
    expect(none[0]).toMatch(/Item/u);
  });

  describe('opened from the tree', () => {
    let manager: ConnectionManager;
    let results: ResultStore;
    let viewer: TableViewer;
    let connection: { connectionId: string };

    beforeAll(async () => {
      const logger = new RecordingLogger();
      const store = new ConnectionStore({
        state: new FakeMemento(),
        secrets: new FakeSecretStorage(),
        logger,
      });
      manager = new ConnectionManager({
        store,
        drivers: { get: () => Promise.resolve(driver) },
        logger,
      });
      results = new ResultStore();
      viewer = new TableViewer({
        manager,
        results,
        cache: new MetadataCache({ logger }),
        limits: { pageSize: () => 10 },
        logger,
      });
      connection = {
        connectionId: (
          await store.add(
            {
              name: 'neo4j',
              driver: 'neo4j',
              host: TEST_NEO4J.host,
              port: TEST_NEO4J.port,
              user: TEST_NEO4J.user,
            },
            TEST_NEO4J.password,
          )
        ).id,
      };
    }, 60_000);

    afterAll(() => {
      manager.dispose();
    });

    function latest(table: string) {
      return results.forDocument(tableDocumentUri(connection, { name: table })).at(-1);
    }

    it('opens a label with its parts and properties, read-only', async () => {
      const summary = await viewer.open({ target: connection, table: { name: 'Person' } });
      expect(summary.error).toBeUndefined();
      expect(summary.page?.totalRows).toBe(2);
      expect(latest('Person')?.columns.map((column) => column.name)).toEqual([
        '_id',
        '_labels',
        'age',
        'big',
        'born',
        'name',
        'tags',
      ]);
      expect(latest('Person')?.rowCount).toBe(2);
      expect(latest('Person')?.edit).toMatchObject({ editable: false, reason: 'graph' });
    });

    it('pages, counts and sorts', async () => {
      const first = await viewer.open({
        target: connection,
        table: { name: 'Item' },
        sort: { column: 'n', direction: 'desc' },
      });
      expect(first.page).toEqual({ offset: 0, pageSize: 10, totalRows: 25 });
      const view = latest('Item');
      const n = view?.columns.findIndex((column) => column.name === 'n') ?? -1;
      const rows = results.window(first.id, 0, 100)?.rows ?? [];
      expect(rows.map((row) => row[n])).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
      await viewer.reload(first.id, { offset: 20 });
      expect(latest('Item')?.rowCount).toBe(5);
    });

    it('filters by a value written as text, by a number and by part of a text', async () => {
      const byNumber = await viewer.open({
        target: connection,
        table: { name: 'Person' },
        filter: { conditions: [{ column: 'age', operator: 'eq', value: '30' }] },
      });
      expect(byNumber.page?.totalRows).toBe(1);
      const greater = await viewer.open({
        target: connection,
        table: { name: 'Person' },
        filter: { conditions: [{ column: 'age', operator: 'gt', value: '26' }] },
      });
      expect(greater.page?.totalRows).toBe(1);
      const contains = await viewer.open({
        target: connection,
        table: { name: 'Person' },
        filter: { conditions: [{ column: 'name', operator: 'contains', value: 'OB' }] },
      });
      expect(contains.page?.totalRows).toBe(1);
      const own = await viewer.open({
        target: connection,
        table: { name: 'Person' },
        filter: { conditions: [], where: "n.name STARTS WITH 'A'" },
      });
      expect(own.page?.totalRows).toBe(1);
    });

    it('opens a relationship type with its ends', async () => {
      const summary = await viewer.open({
        target: connection,
        table: { name: '[KNOWS]' },
        kind: 'view',
      });
      expect(summary.error).toBeUndefined();
      const view = latest('[KNOWS]');
      expect(view?.columns.map((column) => column.name)).toEqual([
        '_id',
        '_type',
        '_from',
        '_to',
        'since',
      ]);
      const rows = results.window(summary.id, 0, 10)?.rows ?? [];
      expect(rows[0]?.[1]).toBe('KNOWS');
      expect(rows[0]?.[4]).toBe(2020);
    });
  });
});
