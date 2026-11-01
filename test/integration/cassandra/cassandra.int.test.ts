import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import type { Session } from '../../../src/drivers/driver';
import { driver } from '../../../src/drivers/cassandra';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { ResultStore } from '../../../src/services/result-store';
import { TableViewer, tableDocumentUri } from '../../../src/services/table-view';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { TEST_CASSANDRA } from '../../helpers/cassandra-servers';
import { firstColumn, runAll } from '../../helpers/driver-run';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

// docker/compose.yml `cassandra` (V13.22): one node, the CQL port, no sign-in.
const KEYSPACE = 'datanest_it';

function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'test-cassandra',
    name: 'cassandra',
    driver: 'cassandra',
    host: TEST_CASSANDRA.host,
    port: TEST_CASSANDRA.port,
    ...overrides,
  };
}

/** Runs a statement and keeps the error it ends with. */
async function failure(session: Session, cql: string): Promise<DbError> {
  try {
    await runAll(session, cql);
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error(`The statement did not fail: ${cql}`);
}

const ID = '123e4567-e89b-12d3-a456-426614174000';

describe('cassandra driver on a Cassandra node', () => {
  let session: Session;

  beforeAll(async () => {
    session = await driver.openSession(config());
    await runAll(session, `DROP KEYSPACE IF EXISTS ${KEYSPACE}`);
    await runAll(
      session,
      `CREATE KEYSPACE ${KEYSPACE} WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}`,
    );
    await runAll(session, `CREATE TYPE ${KEYSPACE}.address (street text, zip int)`);
    await runAll(
      session,
      `CREATE TABLE ${KEYSPACE}.typed (
        id int PRIMARY KEY, big bigint, vi varint, dec decimal, ts timestamp, d date, t time,
        u uuid, tu timeuuid, ip inet, b blob, flag boolean, txt text, f double, dur duration,
        l list<int>, s set<text>, m map<text, int>, tup frozen<tuple<int, text>>,
        a frozen<address>, note text
      )`,
    );
    await runAll(
      session,
      `INSERT INTO ${KEYSPACE}.typed (id, big, vi, dec, ts, d, t, u, tu, ip, b, flag, txt, f, dur, l, s, m, tup, a)
       VALUES (1, 9007199254740993, 123456789012345678901234567890, 1.10, '2024-02-29T12:30:45.123Z',
       '2024-02-29', '13:14:15.123456789', ${ID}, 50554d6e-29bb-11e5-b345-feff819cdc9f,
       '10.0.0.7', 0xdeadbeef, true, 'héllo ''quoted''', 0.1, 1h30m, [1, 2, 3], {'x', 'y'},
       {'one': 1, 'two': 2}, (7, 'seven'), {street: 'Main', zip: 12345})`,
    );
    await runAll(session, `INSERT INTO ${KEYSPACE}.typed (id) VALUES (2)`);
    await runAll(
      session,
      `CREATE TABLE ${KEYSPACE}.events (
        room text, seq int, body text, tag text, PRIMARY KEY ((room), seq)
      ) WITH CLUSTERING ORDER BY (seq DESC)`,
    );
    await runAll(session, `CREATE INDEX events_tag ON ${KEYSPACE}.events (tag)`);
    for (let seq = 1; seq <= 25; seq += 1) {
      await runAll(
        session,
        `INSERT INTO ${KEYSPACE}.events (room, seq, body, tag) VALUES ('main', ${seq}, 'message ${seq}', '${seq % 2 === 0 ? 'even' : 'odd'}')`,
      );
    }
    await runAll(
      session,
      `INSERT INTO ${KEYSPACE}.events (room, seq, body) VALUES ('side', 1, 'other room')`,
    );
  }, 120_000);

  afterAll(async () => {
    await runAll(session, `DROP KEYSPACE IF EXISTS ${KEYSPACE}`);
    await session.close();
  }, 60_000);

  it('answers a query with typed columns', async () => {
    const result = await runAll(
      session,
      `SELECT id, big, txt, ts, l FROM ${KEYSPACE}.typed WHERE id = 1`,
    );
    expect(result.columnSets[0]).toEqual([
      { name: 'id', dataType: 'int' },
      { name: 'big', dataType: 'bigint' },
      { name: 'txt', dataType: 'text' },
      { name: 'ts', dataType: 'timestamp' },
      { name: 'l', dataType: 'list<int>' },
    ]);
  });

  it('keeps every kind of value exact', async () => {
    const result = await runAll(session, `SELECT * FROM ${KEYSPACE}.typed WHERE id = 1`);
    const names = result.columnSets[0]?.map((column) => column.name) ?? [];
    const row = result.rows[0] ?? [];
    const cell = (name: string) => row[names.indexOf(name)];
    expect(cell('big')).toEqual({ kind: 'bigint', text: '9007199254740993' });
    expect(cell('vi')).toEqual({ kind: 'bigint', text: '123456789012345678901234567890' });
    expect(cell('dec')).toEqual({ kind: 'decimal', text: '1.10' });
    expect(cell('ts')).toEqual({ kind: 'datetime', text: '2024-02-29T12:30:45.123Z' });
    expect(cell('d')).toEqual({ kind: 'datetime', text: '2024-02-29' });
    expect(cell('t')).toEqual({ kind: 'datetime', text: '13:14:15.123456789' });
    expect(cell('u')).toBe(ID);
    expect(cell('tu')).toBe('50554d6e-29bb-11e5-b345-feff819cdc9f');
    expect(cell('ip')).toBe('10.0.0.7');
    expect(cell('b')).toMatchObject({ kind: 'binary', size: 4, preview: 'deadbeef' });
    expect(cell('flag')).toBe(true);
    expect(cell('txt')).toBe("héllo 'quoted'");
    expect(cell('f')).toBe(0.1);
    expect(typeof cell('dur')).toBe('string');
    expect(cell('l')).toEqual({ kind: 'json', text: '[1,2,3]' });
    expect(cell('s')).toEqual({ kind: 'json', text: '["x","y"]' });
    expect(JSON.parse((cell('m') as { text: string }).text)).toEqual({ one: 1, two: 2 });
    expect(cell('tup')).toEqual({ kind: 'json', text: '[7,"seven"]' });
    expect(JSON.parse((cell('a') as { text: string }).text)).toEqual({
      street: 'Main',
      zip: 12345,
    });
  });

  it('gives nulls for what was never written', async () => {
    const result = await runAll(
      session,
      `SELECT big, txt, l, a FROM ${KEYSPACE}.typed WHERE id = 2`,
    );
    expect(result.rows[0]).toEqual([null, null, null, null]);
  });

  it('names the types of collections and user-defined values', async () => {
    const result = await runAll(session, `SELECT m, tup, a FROM ${KEYSPACE}.typed WHERE id = 1`);
    const types = result.columnSets[0]?.map((column) => column.dataType);
    expect(types?.[0]).toBe('map<text, int>');
    expect(types?.[1]).toBe('tuple<int, text>');
    expect(types?.[2]).toBe('address');
  });

  it('reads past the page of the server and cuts at the row limit', async () => {
    const all = await runAll(session, `SELECT seq FROM ${KEYSPACE}.events WHERE room = 'main'`);
    expect(firstColumn(all)).toHaveLength(25);
    expect(firstColumn(all)[0]).toBe(25);
    const limited = await runAll(
      session,
      `SELECT seq FROM ${KEYSPACE}.events WHERE room = 'main'`,
      { rowLimit: 7 },
    );
    expect(firstColumn(limited)).toEqual([25, 24, 23, 22, 21, 20, 19]);
  });

  it('reports what the server says about a statement, without rows', async () => {
    const result = await runAll(
      session,
      `INSERT INTO ${KEYSPACE}.typed (id, note) VALUES (3, 'x')`,
    );
    expect(result.columnSets).toEqual([]);
    expect(result.done.kind).toBe('done');
    await runAll(session, `DELETE FROM ${KEYSPACE}.typed WHERE id = 3`);
  });

  it('maps a syntax error, a missing table and a missing keyspace', async () => {
    expect((await failure(session, 'SELEKT 1')).code).toBe('syntax');
    expect((await failure(session, `SELECT * FROM ${KEYSPACE}.nope`)).code).toBe('not-found');
    expect((await failure(session, 'SELECT * FROM nokeyspace.t')).code).toBe('not-found');
    // A filter on a column nothing indexes needs ALLOW FILTERING, and the server says so.
    expect((await failure(session, `SELECT * FROM ${KEYSPACE}.events WHERE body = 'x'`)).code).toBe(
      'syntax',
    );
  });

  it('fails to connect to a port nobody listens on, and to a missing keyspace', async () => {
    await expect(driver.openSession(config({ port: 7999 }))).rejects.toMatchObject({
      code: 'connection-failed',
    });
    await expect(driver.openSession(config({ database: 'nosuchkeyspace' }))).rejects.toBeInstanceOf(
      DbError,
    );
  }, 60_000);

  it('opens in a keyspace and runs unqualified names', async () => {
    const inside = await driver.openSession(config({ database: KEYSPACE }));
    try {
      const result = await runAll(inside, "SELECT body FROM events WHERE room = 'side'");
      expect(firstColumn(result)).toEqual(['other room']);
    } finally {
      await inside.close();
    }
  });

  it('uses USE and CONSISTENCY like cqlsh', async () => {
    const other = await driver.openSession(config());
    try {
      await runAll(other, `USE ${KEYSPACE}`);
      expect(
        firstColumn(await runAll(other, "SELECT room FROM events WHERE room = 'side'")),
      ).toEqual(['side']);
      const level = await runAll(other, 'CONSISTENCY QUORUM');
      expect(level.done.notice).toContain('QUORUM');
      expect(
        firstColumn(await runAll(other, "SELECT room FROM events WHERE room = 'side'")),
      ).toEqual(['side']);
    } finally {
      await other.close();
    }
  });

  it('lists keyspaces, tables and columns with their roles in the key', async () => {
    expect(await session.metadata.listDatabases()).toEqual(
      expect.arrayContaining([KEYSPACE, 'system', 'system_schema']),
    );
    expect(await session.metadata.listTables({ database: KEYSPACE })).toEqual([
      { name: 'events', kind: 'table' },
      { name: 'typed', kind: 'table' },
    ]);
    const columns = await session.metadata.listColumns({ database: KEYSPACE, name: 'events' });
    expect(columns.map((column) => [column.name, column.primaryKey])).toEqual([
      ['room', true],
      ['seq', true],
      ['body', false],
      ['tag', false],
    ]);
    expect(columns[1]?.dataType).toBe('int');
  });

  it('lists the primary key and the secondary indexes', async () => {
    const indexes = await session.metadata.listIndexes({ database: KEYSPACE, name: 'events' });
    expect(indexes[0]).toMatchObject({
      name: 'PRIMARY KEY',
      columns: ['room', 'seq'],
      primary: true,
    });
    expect(indexes[1]).toMatchObject({ name: 'events_tag', columns: ['tag'], primary: false });
  });

  it('writes the CREATE statements of a table, with its clustering order and index', async () => {
    const statements = await session.metadata.getDefinition({
      kind: 'table',
      database: KEYSPACE,
      name: 'events',
    });
    expect(statements[0]).toContain('PRIMARY KEY (("room"), "seq")');
    expect(statements[0]).toContain('WITH CLUSTERING ORDER BY ("seq" DESC)');
    expect(statements[1]).toMatch(/CREATE INDEX "events_tag" ON "datanest_it"\."events" \(tag\)/u);
    // The statements run: create the table again under another name.
    const copy = statements[0]?.replace('"events"', '"events_copy"') ?? '';
    await runAll(session, copy);
    expect(
      (await session.metadata.listTables({ database: KEYSPACE })).map((table) => table.name),
    ).toContain('events_copy');
    await runAll(session, `DROP TABLE ${KEYSPACE}.events_copy`);
  });

  it('says a missing table is missing', async () => {
    await expect(
      session.metadata.getDefinition({ kind: 'table', database: KEYSPACE, name: 'nope' }),
    ).rejects.toMatchObject({ code: 'not-found' });
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
          await store.add({
            name: 'cassandra',
            driver: 'cassandra',
            host: TEST_CASSANDRA.host,
            port: TEST_CASSANDRA.port,
          })
        ).id,
      };
    }, 60_000);

    afterAll(() => {
      manager.dispose();
    });

    const table = { database: KEYSPACE, name: 'events' };

    function latest() {
      return results.forDocument(tableDocumentUri(connection, table)).at(-1);
    }

    it('opens a table, counts it, and keeps its result read-only', async () => {
      const summary = await viewer.open({ target: connection, table });
      expect(summary.error).toBeUndefined();
      expect(summary.page?.totalRows).toBe(26);
      expect(latest()?.rowCount).toBe(10);
      expect(latest()?.edit).toMatchObject({ editable: false, reason: 'wide-column' });
    });

    it('pages by skipping the rows of the pages before', async () => {
      const first = await viewer.open({
        target: connection,
        table,
        filter: { conditions: [{ column: 'room', operator: 'eq', value: 'main' }] },
      });
      expect(first.page).toEqual({ offset: 0, pageSize: 10, totalRows: 25 });
      const seqOf = () => {
        const index = latest()?.columns.findIndex((column) => column.name === 'seq') ?? -1;
        return (results.window(latest()?.id ?? first.id, 0, 100)?.rows ?? []).map(
          (row) => row[index],
        );
      };
      expect(seqOf()).toEqual([25, 24, 23, 22, 21, 20, 19, 18, 17, 16]);
      await viewer.reload(first.id, { offset: 10 });
      expect(seqOf()).toEqual([15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
      await viewer.reload(latest()?.id ?? first.id, { offset: 20 });
      expect(seqOf()).toEqual([5, 4, 3, 2, 1]);
    });

    it('filters by a text and a number written as text', async () => {
      const byNumber = await viewer.open({
        target: connection,
        table,
        filter: {
          conditions: [
            { column: 'room', operator: 'eq', value: 'main' },
            { column: 'seq', operator: 'eq', value: '7' },
          ],
        },
      });
      expect(byNumber.page?.totalRows).toBe(1);
      const own = await viewer.open({
        target: connection,
        table,
        filter: { conditions: [], where: "room = 'main' AND seq > 20" },
      });
      expect(own.page?.totalRows).toBe(5);
    });
  });
});
