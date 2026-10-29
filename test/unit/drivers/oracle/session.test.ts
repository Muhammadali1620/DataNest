import type { Metadata } from 'oracledb';
import oracledb from 'oracledb';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type { ExecuteEvent, Session } from '../../../../src/drivers/driver';
import type * as ExactDates from '../../../../src/drivers/oracle/exact-dates';
import { installExactDates } from '../../../../src/drivers/oracle/exact-dates';
import {
  connectString,
  DEFAULT_SERVICE,
  fetchTypeHandler,
  openOracleSession,
  ROW_BATCH_SIZE,
  SESSION_SETUP,
} from '../../../../src/drivers/oracle/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { runAll } from '../../../helpers/driver-run';

const { getConnection } = vi.hoisted(() => ({
  getConnection: vi.fn<(options: unknown) => Promise<unknown>>(),
}));

// node-oracledb never runs here: the session talks to the fake connection below.
vi.mock('oracledb', () => {
  const type = (name: string) => ({ name });
  const DB_TYPE_NUMBER = type('DB_TYPE_NUMBER');
  const DB_TYPE_VARCHAR = type('DB_TYPE_VARCHAR');
  const DB_TYPE_RAW = type('DB_TYPE_RAW');
  return {
    default: {
      getConnection,
      DB_TYPE_NUMBER,
      DB_TYPE_VARCHAR,
      DB_TYPE_RAW,
      DB_TYPE_CLOB: type('DB_TYPE_CLOB'),
      DB_TYPE_NCLOB: type('DB_TYPE_NCLOB'),
      DB_TYPE_LONG: type('DB_TYPE_LONG'),
      DB_TYPE_LONG_NVARCHAR: type('DB_TYPE_LONG_NVARCHAR'),
      DB_TYPE_ROWID: type('DB_TYPE_ROWID'),
      DB_TYPE_UROWID: type('DB_TYPE_UROWID'),
      DB_TYPE_BLOB: type('DB_TYPE_BLOB'),
      DB_TYPE_LONG_RAW: type('DB_TYPE_LONG_RAW'),
      DB_TYPE_DATE: type('DB_TYPE_DATE'),
      DB_TYPE_TIMESTAMP_TZ: type('DB_TYPE_TIMESTAMP_TZ'),
      STRING: DB_TYPE_VARCHAR,
      BUFFER: DB_TYPE_RAW,
      NUMBER: DB_TYPE_NUMBER,
      OUT_FORMAT_ARRAY: 4001,
      BIND_OUT: 3003,
      BIND_INOUT: 3002,
    },
  };
});

vi.mock('../../../../src/drivers/oracle/exact-dates', async (original) => ({
  ...(await original<typeof ExactDates>()),
  installExactDates: vi.fn(),
}));

interface Call {
  readonly sql: string;
  readonly binds: unknown;
  readonly options: Record<string, unknown> | undefined;
}

class FakeResultSet {
  readonly close = vi.fn(() => Promise.resolve());
  readonly asked: number[] = [];
  failAfter: number | undefined;

  constructor(
    private readonly rows: unknown[][],
    readonly metaData: readonly Record<string, unknown>[] = [],
  ) {}

  getRows(count: number): Promise<unknown[][]> {
    this.asked.push(count);
    if (this.failAfter !== undefined && this.asked.length > this.failAfter) {
      return Promise.reject(Object.assign(new Error('ORA-03113: end-of-file'), { errorNum: 3113 }));
    }
    return Promise.resolve(this.rows.splice(0, count));
  }
}

type Answer = Record<string, unknown> | Error | Promise<Record<string, unknown>>;

/** A connection that records each statement and answers through `respond`. */
class FakeConnection {
  transactionInProgress: boolean | undefined = false;
  readonly calls: Call[] = [];
  respond: (sql: string, binds: unknown) => Answer = () => ({});
  readonly close = vi.fn(() => Promise.resolve());
  readonly breakExecution = vi.fn(() => Promise.resolve());

  execute(sql: string, binds?: unknown, options?: Record<string, unknown>): Promise<unknown> {
    this.calls.push({ sql, binds, options });
    try {
      const answer = this.respond(sql, binds);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  /** Statements a test ran, after the two of the session setup. */
  get ran(): Call[] {
    return this.calls.slice(2);
  }
}

const config: ResolvedConnectionConfig = {
  id: 'c',
  name: 'n',
  driver: 'oracle',
  host: 'db.example',
  user: 'app',
  password: 'secret',
  database: 'ORCL',
};

const oraError = (errorNum: number, extra: Record<string, unknown> = {}) =>
  Object.assign(new Error(`ORA-${String(errorNum).padStart(5, '0')}: failed`), {
    errorNum,
    code: `ORA-${String(errorNum).padStart(5, '0')}`,
    ...extra,
  });

let connection: FakeConnection;

async function open(overrides: Partial<ResolvedConnectionConfig> = {}): Promise<Session> {
  return await openOracleSession({ ...config, ...overrides });
}

async function events(session: Session, sql: string, rowLimit?: number): Promise<ExecuteEvent[]> {
  const all: ExecuteEvent[] = [];
  for await (const event of session.execute(sql, rowLimit === undefined ? {} : { rowLimit })) {
    all.push(event);
  }
  return all;
}

beforeEach(() => {
  connection = new FakeConnection();
  getConnection.mockResolvedValue(connection);
});

describe('connectString', () => {
  it('joins host, port and service', () => {
    expect(connectString({ ...config, port: 7521 })).toBe('db.example:7521/ORCL');
  });

  it('takes port 1521 and the FREEPDB1 service when none are given', () => {
    expect(connectString({ ...config, database: undefined })).toBe('db.example:1521/FREEPDB1');
    expect(connectString({ ...config, database: '' })).toBe('db.example:1521/FREEPDB1');
    expect(DEFAULT_SERVICE).toBe('FREEPDB1');
  });

  it('puts brackets around IPv6 addresses once, and falls back to localhost', () => {
    expect(connectString({ ...config, host: '::1' })).toBe('[::1]:1521/ORCL');
    expect(connectString({ ...config, host: 'fe80::1%eth0' })).toBe('[fe80::1%eth0]:1521/ORCL');
    expect(connectString({ ...config, host: '[::1]' })).toBe('[::1]:1521/ORCL');
    expect(connectString({ ...config, host: undefined })).toBe('localhost:1521/ORCL');
  });
});

describe('fetchTypeHandler', () => {
  const handled = (dbType: unknown) => fetchTypeHandler({ dbType } as unknown as Metadata<unknown>);

  it('fetches numbers, LOB text, LONG and ROWIDs as text', () => {
    for (const dbType of [
      oracledb.DB_TYPE_NUMBER,
      oracledb.DB_TYPE_CLOB,
      oracledb.DB_TYPE_NCLOB,
      oracledb.DB_TYPE_LONG,
      oracledb.DB_TYPE_LONG_NVARCHAR,
      oracledb.DB_TYPE_ROWID,
      oracledb.DB_TYPE_UROWID,
    ]) {
      expect(handled(dbType)).toEqual({ type: oracledb.STRING });
    }
  });

  it('fetches BLOB and LONG RAW as bytes', () => {
    expect(handled(oracledb.DB_TYPE_BLOB)).toEqual({ type: oracledb.BUFFER });
    expect(handled(oracledb.DB_TYPE_LONG_RAW)).toEqual({ type: oracledb.BUFFER });
  });

  it('leaves every other type to the driver', () => {
    expect(handled(oracledb.DB_TYPE_DATE)).toBeUndefined();
    expect(handled(oracledb.DB_TYPE_VARCHAR)).toBeUndefined();
    expect(handled(oracledb.DB_TYPE_TIMESTAMP_TZ)).toBeUndefined();
    expect(handled(undefined)).toBeUndefined();
  });
});

describe('SESSION_SETUP', () => {
  it('sets ISO date formats and a decimal point in one statement', () => {
    expect(SESSION_SETUP).toBe(
      "ALTER SESSION SET NLS_DATE_FORMAT = 'YYYY-MM-DD HH24:MI:SS'" +
        " NLS_TIMESTAMP_FORMAT = 'YYYY-MM-DD HH24:MI:SSXFF'" +
        " NLS_TIMESTAMP_TZ_FORMAT = 'YYYY-MM-DD HH24:MI:SSXFF TZH:TZM'" +
        " NLS_NUMERIC_CHARACTERS = '.,'",
    );
  });
});

describe('openOracleSession', () => {
  it('connects with the credentials, the connect string and the default timeout', async () => {
    await open();
    expect(getConnection).toHaveBeenCalledWith({
      user: 'app',
      password: 'secret',
      connectString: 'db.example:1521/ORCL',
      connectTimeout: 10,
    });
    expect(vi.mocked(installExactDates)).toHaveBeenCalled();
  });

  it('uses the connect timeout of the options and empty credentials when none are given', async () => {
    await open({ user: undefined, password: undefined, options: { connectTimeout: 3 } });
    expect(getConnection).toHaveBeenCalledWith(
      expect.objectContaining({ user: '', password: '', connectTimeout: 3 }),
    );
  });

  it('sets the session formats, then turns DBMS_OUTPUT on', async () => {
    await open();
    expect(connection.calls.map((call) => call.sql)).toEqual([
      SESSION_SETUP,
      'BEGIN DBMS_OUTPUT.ENABLE(NULL); END;',
    ]);
  });

  it('names the service as its one database, FREEPDB1 when none is given', async () => {
    expect(await (await open()).metadata.listDatabases()).toEqual(['ORCL']);
    expect(await (await open({ database: '' })).metadata.listDatabases()).toEqual(['FREEPDB1']);
    expect(await (await open({ database: undefined })).metadata.listDatabases()).toEqual([
      'FREEPDB1',
    ]);
  });

  it('refuses TLS before connecting', async () => {
    await expect(open({ ssl: { mode: 'require' } })).rejects.toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
    expect(getConnection).not.toHaveBeenCalled();
  });

  it('maps a failed connection', async () => {
    getConnection.mockRejectedValue(oraError(1017));
    await expect(open()).rejects.toThrow(expect.objectContaining({ code: 'auth-failed' }));
    getConnection.mockRejectedValue(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
    await expect(open()).rejects.toThrow(expect.objectContaining({ code: 'connection-failed' }));
    getConnection.mockRejectedValue(Object.assign(new Error('no service'), { code: 'NJS-518' }));
    await expect(open()).rejects.toThrow(expect.objectContaining({ code: 'not-found' }));
  });

  it('closes the connection when the session formats cannot be set', async () => {
    connection.respond = (sql) => (sql === SESSION_SETUP ? oraError(1031) : {});
    await expect(open()).rejects.toThrow(expect.objectContaining({ code: 'permission-denied' }));
    expect(connection.close).toHaveBeenCalledOnce();
    expect(connection.calls).toHaveLength(1);
  });

  it('closes the connection when DBMS_OUTPUT cannot be turned on', async () => {
    connection.respond = (sql) => (sql.includes('DBMS_OUTPUT.ENABLE') ? oraError(6550) : {});
    await expect(open()).rejects.toThrow(expect.objectContaining({ code: 'syntax' }));
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('throws the setup error even when closing fails too', async () => {
    connection.respond = () => oraError(3113);
    connection.close.mockRejectedValue(new Error('already gone'));
    await expect(open()).rejects.toThrow(expect.objectContaining({ code: 'connection-failed' }));
  });
});

describe('OracleSession.execute', () => {
  const META = [
    { name: 'ID', dbTypeName: 'NUMBER', precision: 10, scale: 0 },
    { name: '', dbTypeName: 'VARCHAR2' },
    { name: 'X' },
  ];

  it('sends columns, then rows converted by their types, then done', async () => {
    const resultSet = new FakeResultSet(
      [
        ['42', 'a', 1.5],
        ['.5', null, true],
      ],
      [],
    );
    connection.respond = () => ({ resultSet, metaData: META });
    const session = await open();
    expect(await events(session, 'SELECT * FROM "T"')).toEqual([
      {
        kind: 'columns',
        columns: [
          { name: 'ID', dataType: 'NUMBER(10)' },
          { name: 'column2', dataType: 'VARCHAR2' },
          { name: 'X' },
        ],
      },
      {
        kind: 'rows',
        rows: [
          [42, 'a', 1.5],
          [{ kind: 'decimal', text: '0.5' }, null, true],
        ],
      },
      { kind: 'done' },
    ]);
    expect(resultSet.close).toHaveBeenCalledOnce();
  });

  it('runs the statement as given, in array format, with the type handler and batches', async () => {
    const session = await open();
    await runAll(session, 'SELECT 1 FROM dual');
    expect(connection.ran[0]).toEqual({
      sql: 'SELECT 1 FROM dual',
      binds: [],
      options: {
        resultSet: true,
        outFormat: oracledb.OUT_FORMAT_ARRAY,
        autoCommit: true,
        fetchTypeHandler,
        fetchArraySize: ROW_BATCH_SIZE,
      },
    });
  });

  it('reads the column metadata of the result set when the result has none', async () => {
    const resultSet = new FakeResultSet([['1']], [{ name: 'N', dbTypeName: 'NUMBER' }]);
    connection.respond = () => ({ resultSet });
    const result = await runAll(await open(), 'SELECT 1 n FROM dual');
    expect(result.columnSets).toEqual([[{ name: 'N', dataType: 'NUMBER' }]]);
    expect(result.rows).toEqual([[1]]);
  });

  it('converts values beyond the known columns as plain values', async () => {
    const resultSet = new FakeResultSet([['1', '2']], [{ name: 'N', dbTypeName: 'NUMBER' }]);
    connection.respond = () => ({ resultSet });
    expect((await runAll(await open(), 'SELECT 1, 2 FROM dual')).rows).toEqual([[1, '2']]);
  });

  it('sends rows in batches of the batch size', async () => {
    const rows = Array.from({ length: ROW_BATCH_SIZE + 5 }, (_, index) => [String(index)]);
    const resultSet = new FakeResultSet(rows);
    connection.respond = () => ({ resultSet, metaData: [{ name: 'N', dbTypeName: 'NUMBER' }] });
    const all = await events(await open(), 'SELECT n FROM t');
    expect(all.map((event) => (event.kind === 'rows' ? event.rows.length : event.kind))).toEqual([
      'columns',
      ROW_BATCH_SIZE,
      5,
      'done',
    ]);
    expect(resultSet.asked).toEqual([ROW_BATCH_SIZE, ROW_BATCH_SIZE, ROW_BATCH_SIZE]);
  });

  it('stops at the row limit and closes the cursor', async () => {
    const rows = Array.from({ length: 500 }, (_, index) => [String(index)]);
    const resultSet = new FakeResultSet(rows);
    connection.respond = () => ({ resultSet, metaData: [{ name: 'N', dbTypeName: 'NUMBER' }] });
    const result = await runAll(await open(), 'SELECT n FROM t', { rowLimit: 250 });
    expect(result.rows).toHaveLength(250);
    expect(resultSet.asked).toEqual([ROW_BATCH_SIZE, 50]);
    expect(resultSet.close).toHaveBeenCalledOnce();
  });

  it('sends no rows for a row limit of zero', async () => {
    const resultSet = new FakeResultSet([['1']]);
    connection.respond = () => ({ resultSet, metaData: [{ name: 'N' }] });
    const result = await runAll(await open(), 'SELECT 1 FROM dual', { rowLimit: 0 });
    expect(result.rows).toEqual([]);
    expect(resultSet.asked).toEqual([]);
  });

  it('closes the cursor when the reader stops early', async () => {
    const resultSet = new FakeResultSet([['1'], ['2']]);
    connection.respond = () => ({ resultSet, metaData: [{ name: 'N' }] });
    const session = await open();
    for await (const event of session.execute('SELECT n FROM t')) {
      if (event.kind === 'columns') {
        break;
      }
    }
    expect(resultSet.close).toHaveBeenCalledOnce();
  });

  it('maps an error while fetching and still closes the cursor, even if that fails', async () => {
    const resultSet = new FakeResultSet([['1']]);
    resultSet.failAfter = 0;
    resultSet.close.mockRejectedValue(new Error('gone'));
    connection.respond = () => ({ resultSet, metaData: [{ name: 'N' }] });
    await expect(runAll(await open(), 'SELECT n FROM t')).rejects.toThrow(
      expect.objectContaining({ code: 'connection-failed' }),
    );
    expect(resultSet.close).toHaveBeenCalledOnce();
  });

  it('maps a failed statement with its position', async () => {
    const session = await open();
    connection.respond = () => oraError(942, { offset: 14 });
    const error: unknown = await runAll(session, 'SELECT * FROM missing').catch(
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({ code: 'not-found', position: 14, driverCode: 'ORA-00942' });
  });

  it.each([
    'INSERT INTO t VALUES (1)',
    'update t set a = 1',
    'DELETE FROM t',
    'MERGE INTO t USING s ON (1 = 1) WHEN MATCHED THEN UPDATE SET a = 1',
    '/* note */ UPDATE t SET a = 2',
  ])('reports the rows %s changed', async (sql) => {
    connection.respond = () => ({ rowsAffected: 3 });
    expect((await runAll(await open(), sql)).done).toEqual({ kind: 'done', affectedRows: 3 });
  });

  it.each([
    'CREATE TABLE t (a NUMBER)',
    'ALTER TABLE t ADD (b NUMBER)',
    'TRUNCATE TABLE t',
    'COMMIT',
  ])('reports no row count for %s', async (sql) => {
    connection.respond = () => ({ rowsAffected: 0 });
    expect((await runAll(await open(), sql)).done).toEqual({ kind: 'done' });
  });

  it('reports no row count when the driver gives none', async () => {
    connection.respond = () => ({});
    expect((await runAll(await open(), 'INSERT INTO t VALUES (1)')).done).toEqual({ kind: 'done' });
  });

  it('reads back what a PL/SQL block printed, and no row count', async () => {
    connection.respond = (sql) =>
      sql.includes('GET_LINES')
        ? { outBinds: { lines: ['hello', 'world', ''] } }
        : { rowsAffected: 1 };
    const session = await open();
    const result = await runAll(session, "BEGIN DBMS_OUTPUT.PUT_LINE('hello'); END;");
    expect(result.done).toEqual({ kind: 'done', notice: 'hello\nworld' });
    expect(connection.ran[1]).toEqual({
      sql: 'BEGIN DBMS_OUTPUT.GET_LINES(:lines, :count); END;',
      binds: {
        lines: { dir: oracledb.BIND_OUT, type: oracledb.STRING, maxArraySize: 1000 },
        count: { dir: oracledb.BIND_INOUT, type: oracledb.NUMBER, val: 1000 },
      },
      options: undefined,
    });
  });

  it('reads the output after DECLARE and CALL too, but not after other statements', async () => {
    connection.respond = (sql) => (sql.includes('GET_LINES') ? { outBinds: { lines: ['x'] } } : {});
    const session = await open();
    expect((await runAll(session, 'DECLARE n NUMBER; BEGIN NULL; END;')).done.notice).toBe('x');
    expect((await runAll(session, 'CALL p()')).done.notice).toBe('x');
    expect((await runAll(session, 'INSERT INTO t VALUES (1)')).done.notice).toBeUndefined();
    expect(connection.ran.filter((call) => call.sql.includes('GET_LINES'))).toHaveLength(2);
  });

  it('gives no notice when nothing was printed', async () => {
    for (const outBinds of [{ lines: [] }, { lines: ['', '  '] }, {}, undefined, { lines: 'x' }]) {
      connection.respond = (sql) => (sql.includes('GET_LINES') ? { outBinds } : {});
      expect((await runAll(await open(), 'BEGIN NULL; END;')).done).toEqual({ kind: 'done' });
    }
  });

  it('prints lines that are not text as empty lines', async () => {
    connection.respond = (sql) =>
      sql.includes('GET_LINES') ? { outBinds: { lines: ['a', null, 'b'] } } : {};
    expect((await runAll(await open(), 'BEGIN NULL; END;')).done.notice).toBe('a\n\nb');
  });

  it('turns a compiled-with-errors warning into a syntax error with the compiler lines', async () => {
    connection.respond = (sql) =>
      sql.includes('user_errors')
        ? {
            rows: [
              [3, 5, 'PLS-00103: Encountered the symbol "END"\n'],
              [7, 1, 'PLS-00201: identifier must be declared'],
            ],
          }
        : { warning: { message: 'ORA-24344: success with compilation error' } };
    const error: unknown = await runAll(
      await open(),
      'CREATE OR REPLACE PROCEDURE p IS BEGIN x; END;',
    ).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DbError);
    expect(error).toMatchObject({
      code: 'syntax',
      message:
        'Compiled with errors: line 3, column 5: PLS-00103: Encountered the symbol "END"; line 7, column 1: PLS-00201: identifier must be declared',
    });
  });

  it('falls back to the warning itself when the compiler lines cannot be read', async () => {
    connection.respond = (sql) =>
      sql.includes('user_errors') ? { rows: [] } : { warning: { message: 'ORA-24344: warned' } };
    await expect(runAll(await open(), 'CREATE TRIGGER t …')).rejects.toThrow(
      expect.objectContaining({ code: 'syntax', message: 'ORA-24344: warned' }),
    );
    connection.respond = (sql) => (sql.includes('user_errors') ? oraError(942) : { warning: {} });
    await expect(runAll(await open(), 'CREATE TRIGGER t …')).rejects.toThrow(
      expect.objectContaining({ code: 'syntax', message: 'Compiled with errors' }),
    );
  });
});

describe('OracleSession transactions', () => {
  const autoCommits = () => connection.ran.map((call) => call.options?.autoCommit);

  it('commits each statement by itself outside a transaction begun on purpose', async () => {
    const session = await open();
    await runAll(session, 'INSERT INTO t VALUES (1)');
    await runAll(session, 'UPDATE t SET a = 2');
    expect(autoCommits()).toEqual([true, true]);
  });

  it('stops committing after SET TRANSACTION until COMMIT', async () => {
    const session = await open();
    await runAll(session, 'SET TRANSACTION READ WRITE');
    connection.transactionInProgress = true;
    await runAll(session, 'INSERT INTO t VALUES (1)');
    await runAll(session, 'COMMIT');
    connection.transactionInProgress = false;
    await runAll(session, 'INSERT INTO t VALUES (2)');
    expect(autoCommits()).toEqual([false, false, false, true]);
  });

  it('stops committing after a savepoint until ROLLBACK, also past ROLLBACK TO', async () => {
    const session = await open();
    connection.transactionInProgress = true;
    await runAll(session, 'SAVEPOINT a');
    await runAll(session, 'DELETE FROM t');
    await runAll(session, 'ROLLBACK TO SAVEPOINT a');
    await runAll(session, 'DELETE FROM t');
    await runAll(session, 'ROLLBACK');
    connection.transactionInProgress = false;
    await runAll(session, 'DELETE FROM t');
    expect(autoCommits()).toEqual([false, false, false, false, false, true]);
  });

  it('commits by itself again once the server has no transaction open', async () => {
    const session = await open();
    await runAll(session, 'SET TRANSACTION READ WRITE');
    // DDL commits the transaction on the server.
    await runAll(session, 'CREATE TABLE t (a NUMBER)');
    await runAll(session, 'INSERT INTO t VALUES (1)');
    expect(autoCommits()).toEqual([false, false, true]);
  });

  it('reports the state the driver last heard from the server', async () => {
    const session = await open();
    expect(session.transactionState?.()).toBe('idle');
    connection.transactionInProgress = true;
    expect(session.transactionState?.()).toBe('open');
    connection.transactionInProgress = undefined;
    expect(session.transactionState?.()).toBe('idle');
  });
});

describe('OracleSession cancel and close', () => {
  it('breaks a running statement on the wire', async () => {
    let fail: (error: Error) => void = () => undefined;
    connection.respond = (sql) =>
      sql.startsWith('SELECT')
        ? new Promise<Record<string, unknown>>((_resolve, reject) => {
            fail = reject;
          })
        : {};
    const session = await open();
    const pending = runAll(session, 'SELECT * FROM big');
    await session.cancel();
    expect(connection.breakExecution).toHaveBeenCalledOnce();
    fail(oraError(1013));
    await expect(pending).rejects.toThrow(expect.objectContaining({ code: 'cancelled' }));
  });

  it('does nothing when no statement runs', async () => {
    const session = await open();
    await session.cancel();
    await runAll(session, 'SELECT 1 FROM dual');
    await session.cancel();
    expect(connection.breakExecution).not.toHaveBeenCalled();
  });

  it('maps a failed break', async () => {
    connection.respond = (sql) =>
      sql.startsWith('SELECT') ? new Promise<Record<string, unknown>>(() => undefined) : {};
    connection.breakExecution.mockRejectedValue(Object.assign(new Error('x'), { code: 'NJS-003' }));
    const session = await open();
    void runAll(session, 'SELECT * FROM big').catch(() => undefined);
    await expect(session.cancel()).rejects.toThrow(
      expect.objectContaining({ code: 'connection-failed' }),
    );
  });

  it('closes the connection once, even when asked twice or closing fails', async () => {
    connection.close.mockRejectedValue(new Error('gone'));
    const session = await open();
    await session.close();
    await session.close();
    expect(connection.close).toHaveBeenCalledOnce();
  });

  it('does not cancel after close', async () => {
    const session = await open();
    await session.close();
    await session.cancel();
    expect(connection.breakExecution).not.toHaveBeenCalled();
  });

  it('refuses to run or query after close', async () => {
    const session = await open();
    await session.close();
    await expect(runAll(session, 'SELECT 1 FROM dual')).rejects.toThrow(
      expect.objectContaining({
        code: 'internal',
        message: expect.stringMatching(/closed/u) as unknown,
      }),
    );
    await expect(session.metadata.listSchemas()).rejects.toThrow(
      expect.objectContaining({ code: 'internal' }),
    );
    expect(connection.ran).toEqual([]);
  });
});

describe('OracleSession.query', () => {
  interface Querying {
    query(sql: string, binds?: Record<string, string>): Promise<unknown[][]>;
  }

  it('runs a catalog query with binds and gives its rows', async () => {
    connection.respond = () => ({ rows: [['A'], ['B']] });
    const session = (await open()) as unknown as Querying;
    expect(await session.query('SELECT :x FROM dual', { x: '1' })).toEqual([['A'], ['B']]);
    expect(connection.ran[0]).toEqual({
      sql: 'SELECT :x FROM dual',
      binds: { x: '1' },
      options: { outFormat: oracledb.OUT_FORMAT_ARRAY, fetchTypeHandler },
    });
  });

  it('binds nothing by default and gives no rows when the driver has none', async () => {
    connection.respond = () => ({});
    const session = (await open()) as unknown as Querying;
    expect(await session.query('BEGIN NULL; END;')).toEqual([]);
    expect(connection.ran[0]?.binds).toEqual({});
  });

  it('maps errors', async () => {
    const session = (await open()) as unknown as Querying;
    connection.respond = () => oraError(942);
    await expect(session.query('SELECT * FROM missing')).rejects.toThrow(
      expect.objectContaining({ code: 'not-found' }),
    );
  });

  it('serves the metadata reader', async () => {
    connection.respond = () => ({ rows: [['DATANEST'], ['HR']] });
    const session = await open();
    expect(await session.metadata.listSchemas()).toEqual(['DATANEST', 'HR']);
    expect(connection.ran[0]?.sql).toContain('FROM all_users');
  });
});
