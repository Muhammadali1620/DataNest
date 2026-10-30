import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { ExecuteEvent, Session } from '../../../../src/drivers/driver';
import {
  canAnalyze,
  explainStatement,
  planServerOf,
} from '../../../../src/services/explain/explain';
import type { CellValue } from '../../../../src/shared/cell-value';
import { FakeMetadata } from '../../../helpers/fake-driver';
import { fixtureJson, fixtureText } from '../../../helpers/fixtures';

interface Set {
  readonly columns: string[];
  readonly rows: CellValue[][];
}

/** A session that answers each statement from `answer`: result sets, or an error. */
function scripted(answer: (sql: string) => Set[] | Error) {
  const executed: string[] = [];
  const session: Session = {
    metadata: new FakeMetadata(),
    execute(sql: string): AsyncIterable<ExecuteEvent> {
      executed.push(sql);
      const reply = answer(sql);
      return (async function* () {
        await Promise.resolve();
        if (reply instanceof Error) {
          throw reply;
        }
        for (const set of reply) {
          yield { kind: 'columns', columns: set.columns.map((name) => ({ name })) };
          yield { kind: 'rows', rows: set.rows };
        }
        yield { kind: 'done' };
      })();
    },
    cancel: () => Promise.resolve(),
    close: () => Promise.resolve(),
  };
  return { session, executed };
}

const one = (value: CellValue, column = 'x'): Set[] => [{ columns: [column], rows: [[value]] }];

describe('planServerOf', () => {
  it('tells PostgreSQL from CockroachDB', async () => {
    const pg = scripted(() => one('PostgreSQL 17.11 on x86_64'));
    expect(await planServerOf(pg.session, 'postgres')).toBe('postgres');
    expect(pg.executed).toEqual(['SELECT version()']);
    const cockroach = scripted(() => one('CockroachDB CCL v25.2.1'));
    expect(await planServerOf(cockroach.session, 'postgres')).toBe('cockroach');
  });

  it('tells MySQL 8, older MySQL, MariaDB and TiDB apart', async () => {
    const of = async (version: string) =>
      await planServerOf(scripted(() => one(version)).session, 'mysql');
    expect(await of('8.4.13')).toBe('mysql');
    expect(await of('8.0.18')).toBe('mysql');
    expect(await of('8.0.17')).toBe('mysql-old');
    expect(await of('5.7.44-log')).toBe('mysql-old');
    expect(await of('11.4.13-MariaDB-ubu2404')).toBe('mariadb');
    expect(await of('8.0.11-TiDB-v8.5.1')).toBe('tidb');
  });

  it('needs no question for the other drivers', async () => {
    const { session, executed } = scripted(() => []);
    for (const driver of ['sqlite', 'mssql', 'clickhouse', 'oracle'] as const) {
      expect(await planServerOf(session, driver)).toBe(driver);
    }
    expect(executed).toEqual([]);
  });
});

describe('canAnalyze', () => {
  it('lists the servers that can run a statement for its plan', () => {
    expect(
      ['postgres', 'cockroach', 'mysql', 'mariadb', 'tidb', 'mssql'].every((server) =>
        canAnalyze(server as never),
      ),
    ).toBe(true);
    expect(canAnalyze('sqlite')).toBe(false);
    expect(canAnalyze('clickhouse')).toBe(false);
    expect(canAnalyze('oracle')).toBe(false);
    expect(canAnalyze('mysql-old')).toBe(false);
  });
});

describe('explainStatement', () => {
  it('asks PostgreSQL for JSON, with ANALYZE and BUFFERS when the statement runs', async () => {
    const plan = fixtureText('explain', 'postgres-analyze.json');
    const { session, executed } = scripted(() => one({ kind: 'json', text: plan }, 'QUERY PLAN'));
    const result = await explainStatement(session, 'postgres', '  SELECT 1;  ', true);
    expect(executed).toEqual(['EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) SELECT 1']);
    expect(result.analyzed).toBe(true);
    await explainStatement(session, 'postgres', 'SELECT 1', false);
    expect(executed.at(-1)).toBe('EXPLAIN (FORMAT JSON) SELECT 1');
  });

  it('speaks to each server in its own words', async () => {
    const cases = [
      ['cockroach', 'EXPLAIN SELECT 1', one('• scan')],
      ['mysql', 'EXPLAIN FORMAT=TREE SELECT 1', one(fixtureText('explain', 'mysql-tree.txt'))],
      ['mariadb', 'EXPLAIN FORMAT=JSON SELECT 1', one(fixtureText('explain', 'mariadb-plan.json'))],
      [
        'sqlite',
        'EXPLAIN QUERY PLAN SELECT 1',
        [{ columns: ['id', 'parent', 'notused', 'detail'], rows: [[2, 0, 0, 'SCAN t']] }],
      ],
      [
        'clickhouse',
        'EXPLAIN json = 1, indexes = 1, description = 1 SELECT 1',
        one(fixtureText('explain', 'clickhouse-plan.json')),
      ],
    ] as const;
    for (const [server, expected, reply] of cases) {
      const sets: Set[] = reply.map((set) => ({
        columns: [...set.columns],
        rows: set.rows.map((row) => [...row]),
      }));
      const { session, executed } = scripted(() => sets);
      await explainStatement(session, server, 'SELECT 1', false);
      expect(executed, server).toEqual([expected]);
    }
  });

  it('reads TiDB and old MySQL as a table and keeps the table as the original', async () => {
    const tidb = fixtureJson('explain', 'tidb-analyze.json') as Set;
    const { session, executed } = scripted(() => [tidb]);
    const plan = await explainStatement(session, 'tidb', 'SELECT 1', true);
    expect(executed).toEqual(['EXPLAIN ANALYZE SELECT 1']);
    expect(plan.raw.split('\n')[0]).toBe(tidb.columns.join('\t'));
    const classic = fixtureJson('explain', 'mysql-classic.json') as Set;
    const old = scripted(() => [classic]);
    expect(
      (await explainStatement(old.session, 'mysql-old', 'SELECT 1', false)).root.children,
    ).toHaveLength(3);
  });

  it('turns SHOWPLAN on and off around the statement on SQL Server', async () => {
    const xml = fixtureText('explain', 'mssql-estimated.xml');
    const { session, executed } = scripted((sql) =>
      sql.startsWith('SET') ? [] : one(xml, 'Microsoft SQL Server 2005 XML Showplan'),
    );
    const plan = await explainStatement(session, 'mssql', 'SELECT 1', false);
    expect(executed).toEqual(['SET SHOWPLAN_XML ON', 'SELECT 1', 'SET SHOWPLAN_XML OFF']);
    expect(plan.root.operation).toBe('Sort');
  });

  it('takes the plan after the rows with STATISTICS XML', async () => {
    const xml = fixtureText('explain', 'mssql-actual.xml');
    const { session, executed } = scripted((sql) =>
      sql.startsWith('SET')
        ? []
        : [
            { columns: ['full_name', 'n'], rows: [['Alice', 2]] },
            { columns: ['Microsoft SQL Server 2005 XML Showplan'], rows: [[xml]] },
          ],
    );
    const plan = await explainStatement(session, 'mssql', 'SELECT 1', true);
    expect(executed).toEqual(['SET STATISTICS XML ON', 'SELECT 1', 'SET STATISTICS XML OFF']);
    expect(plan.analyzed).toBe(true);
  });

  it('turns SHOWPLAN off even when the statement fails, and says when no plan came', async () => {
    const failing = scripted((sql) => (sql.startsWith('SET') ? [] : new DbError('syntax', 'bad')));
    await expect(explainStatement(failing.session, 'mssql', 'SELEC', false)).rejects.toThrow('bad');
    expect(failing.executed.at(-1)).toBe('SET SHOWPLAN_XML OFF');
    const empty = scripted(() => []);
    await expect(explainStatement(empty.session, 'mssql', 'SELECT 1', false)).rejects.toThrow(
      'no plan',
    );
    expect(empty.executed.at(-1)).toBe('SET SHOWPLAN_XML OFF');
  });

  it('writes the Oracle plan under its own id, reads it and deletes it', async () => {
    const table = fixtureJson('explain', 'oracle-plan.json') as Set;
    const { session, executed } = scripted((sql) => (sql.startsWith('SELECT') ? [table] : []));
    const plan = await explainStatement(session, 'oracle', 'SELECT 1 FROM dual', false);
    expect(plan.root.operation).toBe('SELECT STATEMENT');
    const id = /STATEMENT_ID = '(DN[A-Z0-9]+)'/u.exec(executed[0] ?? '')?.[1];
    expect(id).toBeDefined();
    expect(executed[0]).toBe(`EXPLAIN PLAN SET STATEMENT_ID = '${id}' FOR SELECT 1 FROM dual`);
    expect(executed[1]).toContain(`FROM plan_table WHERE statement_id = '${id}' ORDER BY id`);
    expect(executed[2]).toBe(`DELETE FROM plan_table WHERE statement_id = '${id}'`);
  });

  it('deletes the Oracle plan rows even when reading them fails', async () => {
    const { session, executed } = scripted((sql) =>
      sql.startsWith('SELECT') ? new DbError('permission-denied', 'no plan_table') : [],
    );
    await expect(explainStatement(session, 'oracle', 'SELECT 1 FROM dual', false)).rejects.toThrow(
      'no plan_table',
    );
    expect(executed.at(-1)).toMatch(/^DELETE FROM plan_table/u);
  });

  it('runs nothing for ANALYZE of a statement that may change data', async () => {
    const { session, executed } = scripted(() => []);
    await expect(
      explainStatement(session, 'postgres', 'DELETE FROM orders', true),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      explainStatement(session, 'mysql', 'WITH x AS (SELECT 1) UPDATE t SET a = 1', true),
    ).rejects.toMatchObject({ code: 'unsupported' });
    expect(executed).toEqual([]);
  });

  it('refuses ANALYZE where the server cannot, and an empty statement', async () => {
    const { session, executed } = scripted(() => []);
    await expect(explainStatement(session, 'sqlite', 'SELECT 1', true)).rejects.toMatchObject({
      code: 'unsupported',
    });
    await expect(explainStatement(session, 'postgres', ' ; ', false)).rejects.toMatchObject({
      code: 'syntax',
    });
    expect(executed).toEqual([]);
  });

  it('passes the server error on', async () => {
    const { session } = scripted(() => new DbError('syntax', 'syntax error at or near "SELEC"'));
    await expect(explainStatement(session, 'postgres', 'SELEC 1', false)).rejects.toThrow(
      'syntax error',
    );
  });
});
