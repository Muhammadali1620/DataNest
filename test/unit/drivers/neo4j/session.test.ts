import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { driver } from '../../../../src/drivers/neo4j';
import { countersNotice } from '../../../../src/drivers/neo4j/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { firstColumn, runAll } from '../../../helpers/driver-run';
import { FakeNeo4j, failure, int, list, rows, str } from '../../../helpers/fake-neo4j';

describe('neo4j session', () => {
  let server: FakeNeo4j;

  beforeEach(async () => {
    server = new FakeNeo4j(() => rows(['x'], [[int(1)]]));
    await server.start();
  });

  afterEach(async () => {
    await server.stop();
  });

  function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
    return {
      id: 'c',
      name: 'n',
      driver: 'neo4j',
      host: '127.0.0.1',
      port: server.port,
      user: 'neo4j',
      password: 'pw',
      ...overrides,
    };
  }

  describe('opening', () => {
    it('proves the sign-in with a first statement on the default database', async () => {
      const session = await driver.openSession(config());
      await session.close();
      expect(server.seen).toHaveLength(1);
      expect(server.seen[0]).toMatchObject({
        path: '/db/neo4j/query/v2',
        statement: 'RETURN 1',
        authorization: `Basic ${Buffer.from('neo4j:pw').toString('base64')}`,
        accept: 'application/vnd.neo4j.query',
      });
    });

    it('opens the database the connection names', async () => {
      const session = await driver.openSession(config({ database: ' sales ' }));
      await session.close();
      expect(server.seen[0]?.path).toBe('/db/sales/query/v2');
    });

    it('works against a server without sign-in', async () => {
      const session = await driver.openSession(config({ user: undefined, password: undefined }));
      await session.close();
      expect(server.seen[0]?.authorization).toBeUndefined();
    });

    it('fails with the reason the server gives', async () => {
      server.answer(() =>
        failure(401, 'Neo.ClientError.Security.Unauthorized', 'Invalid credential.'),
      );
      await expect(driver.openSession(config())).rejects.toMatchObject({
        code: 'auth-failed',
        message: 'Invalid credential.',
      });
      server.answer(() =>
        failure(404, 'Neo.ClientError.Database.DatabaseNotFound', 'Graph not found: x'),
      );
      await expect(driver.openSession(config({ database: 'x' }))).rejects.toMatchObject({
        code: 'not-found',
      });
    });

    it('gives up when the server does not answer in time', async () => {
      server.answer(() => ({ hang: true }));
      await expect(
        driver.openSession(config({ options: { connectTimeout: 0.1 } })),
      ).rejects.toMatchObject({ code: 'timeout' });
    });

    it('fails when nobody listens', async () => {
      await server.stop();
      await expect(driver.openSession(config())).rejects.toMatchObject({
        code: 'connection-failed',
      });
    });
  });

  describe('running statements', () => {
    it('streams the columns and the rows of a query', async () => {
      server.answer((seen) =>
        seen.statement === 'RETURN 1'
          ? rows([], [])
          : rows(
              ['n', 'name', 'nothing'],
              [
                [int(1), str('Ann'), { $type: 'Null', _value: null }],
                [int(2), str('Bob'), { $type: 'Null', _value: null }],
              ],
            ),
      );
      const session = await driver.openSession(config());
      const result = await runAll(session, 'MATCH (p) RETURN p.n, p.name, null;');
      expect(result.columnSets[0]).toEqual([
        { name: 'n', dataType: 'integer' },
        { name: 'name', dataType: 'string' },
        { name: 'nothing' },
      ]);
      expect(result.rows).toEqual([
        [1, 'Ann', null],
        [2, 'Bob', null],
      ]);
      // The semicolon stays behind, and the statement is a write unless the connection says not.
      expect(server.seen.at(-1)).toMatchObject({
        statement: 'MATCH (p) RETURN p.n, p.name, null',
        accessMode: 'Write',
      });
      await session.close();
    });

    it('sends the rows in batches and stops at the row limit', async () => {
      const many = Array.from({ length: 450 }, (_unused, index) => [int(index)]);
      server.answer((seen) => (seen.statement === 'RETURN 1' ? rows([], []) : rows(['i'], many)));
      const session = await driver.openSession(config());
      const batches: number[] = [];
      for await (const event of session.execute('UNWIND range(0, 449) AS i RETURN i')) {
        if (event.kind === 'rows') {
          batches.push(event.rows.length);
        }
      }
      expect(batches).toEqual([200, 200, 50]);
      const limited = await runAll(session, 'UNWIND range(0, 449) AS i RETURN i', { rowLimit: 3 });
      expect(firstColumn(limited)).toEqual([0, 1, 2]);
      await session.close();
    });

    it('reports what a writing statement did', async () => {
      server.answer((seen) =>
        seen.statement === 'RETURN 1'
          ? rows([], [])
          : rows([], [], {
              counters: { nodesCreated: 2, relationshipsCreated: 1, propertiesSet: 6 },
              notifications: [{ description: 'a cartesian product' }],
            }),
      );
      const session = await driver.openSession(config());
      const result = await runAll(session, 'CREATE (:A)-[:R]->(:B)');
      expect(result.columnSets).toEqual([]);
      expect(result.done.affectedRows).toBe(3);
      expect(result.done.notice).toBe(
        'Nodes created: 2, Relationships created: 1, Properties set: 6 · a cartesian product',
      );
      await session.close();
    });

    it('says nothing when nothing changed', async () => {
      const session = await driver.openSession(config());
      server.answer(() => rows([], []));
      const result = await runAll(session, 'MATCH (n:None) SET n.a = 1');
      expect(result.done).toEqual({ kind: 'done' });
      await session.close();
    });

    it('asks for a read on a read-only connection', async () => {
      const session = await driver.openSession(config({ readOnly: true }));
      await runAll(session, 'MATCH (n) RETURN n');
      expect(server.seen.at(-1)?.accessMode).toBe('Read');
      await session.close();
    });

    it('turns a label opened from the tree into Cypher and shapes the rows', async () => {
      server.answer((seen) => {
        if (seen.statement.includes('count(n)')) {
          return rows(['count'], [[int(2)]]);
        }
        if (seen.statement.startsWith('MATCH (n:`Person`)\nRETURN')) {
          return rows(
            ['_id', '_labels', '_properties'],
            [
              [
                str('4:x:0'),
                list(str('Person')),
                { $type: 'Map', _value: { name: str('Ann'), age: int(30) } },
              ],
              [
                str('4:x:1'),
                list(str('Person')),
                { $type: 'Map', _value: { name: str('Bob'), nick: str('B') } },
              ],
            ],
          );
        }
        if (seen.statement.includes('count(n)')) {
          return rows(['count'], [[int(2)]]);
        }
        return rows([], []);
      });
      const session = await driver.openSession(config());
      const page = await runAll(session, 'SELECT * FROM `Person` LIMIT 100');
      expect(page.columnSets[0]?.map((column) => column.name)).toEqual([
        '_id',
        '_labels',
        'age',
        'name',
        'nick',
      ]);
      expect(page.rows[0]).toEqual([
        '4:x:0',
        { kind: 'json', text: '["Person"]' },
        30,
        'Ann',
        null,
      ]);
      expect(page.rows[1]).toEqual([
        '4:x:1',
        { kind: 'json', text: '["Person"]' },
        null,
        'Bob',
        'B',
      ]);
      const chosen = await runAll(session, 'SELECT `name`, `_id` FROM `Person`');
      expect(chosen.columnSets[0]?.map((column) => column.name)).toEqual(['name', '_id']);
      expect(chosen.rows[0]).toEqual(['Ann', '4:x:0']);
      const count = await runAll(session, 'SELECT COUNT(*) FROM `Person`');
      expect(firstColumn(count)).toEqual([2]);
      await session.close();
    });

    it('shows the ends and the type of a relationship', async () => {
      server.answer((seen) =>
        seen.statement.startsWith('MATCH ()-[n:`KNOWS`]->()')
          ? rows(
              ['_id', '_type', '_from', '_to', '_properties'],
              [
                [
                  str('5:x:0'),
                  str('KNOWS'),
                  str('4:x:0'),
                  str('4:x:1'),
                  { $type: 'Map', _value: { since: int(2020) } },
                ],
              ],
            )
          : rows([], []),
      );
      const session = await driver.openSession(config());
      const result = await runAll(session, 'SELECT * FROM `[KNOWS]` LIMIT 10');
      expect(result.columnSets[0]?.map((column) => column.name)).toEqual([
        '_id',
        '_type',
        '_from',
        '_to',
        'since',
      ]);
      expect(result.rows[0]).toEqual(['5:x:0', 'KNOWS', '4:x:0', '4:x:1', 2020]);
      await session.close();
    });
  });

  describe('failing and stopping', () => {
    it('turns the error of a statement into a DbError', async () => {
      const session = await driver.openSession(config());
      server.answer(() =>
        failure(400, 'Neo.ClientError.Statement.SyntaxError', "Invalid input 'RETRN'"),
      );
      const error = await runAll(session, 'RETRN 1').catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(DbError);
      expect(error).toMatchObject({ code: 'syntax', message: "Invalid input 'RETRN'" });
      // The session goes on.
      server.answer(() => rows(['x'], [[int(1)]]));
      expect(firstColumn(await runAll(session, 'RETURN 1'))).toEqual([1]);
      await session.close();
    });

    it('cancels the statement in flight by dropping the request', async () => {
      const session = await driver.openSession(config());
      server.answer(() => ({ hang: true }));
      const running = runAll(session, 'UNWIND range(1, 999999999) AS x RETURN count(x)').catch(
        (caught: unknown) => caught,
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      await session.cancel();
      expect(await running).toMatchObject({ code: 'cancelled' });
      server.answer(() => rows(['x'], [[int(5)]]));
      expect(firstColumn(await runAll(session, 'RETURN 5'))).toEqual([5]);
      await session.close();
    });

    it('stops a statement that runs past the query timeout', async () => {
      const session = await driver.openSession(config({ options: { queryTimeout: 0.1 } }));
      server.answer(() => ({ hang: true }));
      await expect(runAll(session, 'RETURN 1')).rejects.toMatchObject({ code: 'timeout' });
      await session.close();
    });

    it('does nothing to cancel when nothing runs', async () => {
      const session = await driver.openSession(config());
      await expect(session.cancel()).resolves.toBeUndefined();
      await session.close();
    });

    it('refuses work after it is closed, and closes twice without harm', async () => {
      const session = await driver.openSession(config());
      await session.close();
      await session.close();
      await expect(runAll(session, 'RETURN 1')).rejects.toMatchObject({ code: 'internal' });
    });

    it('runs one statement at a time', async () => {
      const session = await driver.openSession(config());
      server.answer((seen) => ({
        ...rows(['x'], [[int(1)]]),
        delayMs: seen.statement === 'RETURN 1' ? 80 : 0,
      }));
      const order: string[] = [];
      const first = runAll(session, 'RETURN 1').then(() => order.push('first'));
      const second = runAll(session, 'RETURN 2').then(() => order.push('second'));
      await Promise.all([first, second]);
      expect(order).toEqual(['first', 'second']);
      await session.close();
    });
  });

  describe('metadata', () => {
    it('asks in read mode, with parameters', async () => {
      const session = await driver.openSession(config());
      server.answer(() => rows(['label'], [[str('A')], [str('B')]]));
      const tables = await session.metadata.listTables({});
      expect(tables.map((table) => table.name)).toContain('A');
      expect(server.seen.at(-1)?.accessMode).toBe('Read');
      server.answer(() => rows(['propertyName', 'propertyTypes', 'mandatory'], []));
      await session.metadata.listColumns({ name: 'We`ird' });
      expect(server.seen.at(-1)?.parameters).toEqual({ name: 'We`ird' });
      await session.metadata.listColumns({ name: '[KNOWS]' });
      expect(server.seen.at(-1)?.parameters).toEqual({ name: ':`KNOWS`' });
      await session.close();
    });

    it('cannot ask once the session is closed', async () => {
      const session = await driver.openSession(config());
      await session.close();
      await expect(session.metadata.listDatabases()).rejects.toMatchObject({ code: 'internal' });
    });
  });
});

describe('countersNotice', () => {
  it('names the counters that are not zero', () => {
    expect(countersNotice(undefined)).toBe('');
    expect(countersNotice({ nodesCreated: 0 })).toBe('');
    expect(
      countersNotice({
        nodesCreated: 1,
        nodesDeleted: 2,
        relationshipsCreated: 3,
        relationshipsDeleted: 4,
        propertiesSet: 5,
        labelsAdded: 6,
        labelsRemoved: 7,
        indexesAdded: 8,
        indexesRemoved: 9,
        constraintsAdded: 10,
        constraintsRemoved: 11,
      }),
    ).toBe(
      'Nodes created: 1, Nodes deleted: 2, Relationships created: 3, Relationships deleted: 4, Properties set: 5, Labels added: 6, Labels removed: 7, Indexes added: 8, Indexes removed: 9, Constraints added: 10, Constraints removed: 11',
    );
    expect(countersNotice({ nodesCreated: 'x' })).toBe('');
  });
});
