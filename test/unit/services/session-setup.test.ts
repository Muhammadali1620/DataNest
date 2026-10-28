import { describe, expect, it } from 'vitest';
import { mysqlDialect } from '../../../src/drivers/mysql/dialect';
import { postgresDialect } from '../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../src/drivers/sqlite/dialect';
import { setUpSession, setupStatements } from '../../../src/services/session-setup';
import type { ConnectionInput } from '../../../src/shared/connection';
import { FakeSession } from '../../helpers/fake-driver';

const mysql: ConnectionInput = { name: 'm', driver: 'mysql', host: 'h' };

describe('setupStatements', () => {
  it('is empty for a connection without options', () => {
    expect(setupStatements(mysql, mysqlDialect)).toEqual([]);
  });

  it('sets the time zone first, then runs each init statement', () => {
    expect(
      setupStatements(
        { ...mysql, options: { timeZone: '+03:00', initSql: "SET a = 1;\nSET b = 'x;y';" } },
        mysqlDialect,
      ),
    ).toEqual([
      { sql: "SET time_zone = '+03:00'", origin: 'time-zone' },
      { sql: 'SET a = 1', origin: 'init' },
      { sql: "SET b = 'x;y'", origin: 'init' },
    ]);
  });

  it('splits init SQL the way the driver does: dollar quotes in PostgreSQL', () => {
    const statements = setupStatements(
      {
        name: 'p',
        driver: 'postgres',
        host: 'h',
        options: { initSql: 'DO $$ BEGIN PERFORM 1; END $$;\nSET search_path = app' },
      },
      postgresDialect,
    );
    expect(statements.map((statement) => statement.sql)).toEqual([
      'DO $$ BEGIN PERFORM 1; END $$',
      'SET search_path = app',
    ]);
  });

  it('ignores a time zone where sessions have none', () => {
    expect(
      setupStatements(
        { name: 's', driver: 'sqlite', file: 'a.db', options: { timeZone: 'UTC' } },
        sqliteDialect,
      ),
    ).toEqual([]);
  });

  it('refuses init SQL that would change a read-only connection', () => {
    expect(() =>
      setupStatements(
        { ...mysql, readOnly: true, options: { initSql: 'SET SESSION TRANSACTION READ WRITE' } },
        mysqlDialect,
      ),
    ).toThrow('may not change anything');
    expect(
      setupStatements(
        { ...mysql, readOnly: true, options: { initSql: "SET NAMES 'utf8mb4'" } },
        mysqlDialect,
      ),
    ).toHaveLength(1);
  });
});

describe('setUpSession', () => {
  const session = () => new FakeSession({ id: 'c', name: 'c', driver: 'mysql' });

  it('runs the statements in order on the session', async () => {
    const one = session();
    await setUpSession(
      one,
      { ...mysql, options: { timeZone: 'UTC', initSql: 'SET a = 1' } },
      mysqlDialect,
    );
    expect(one.executed).toEqual(["SET time_zone = 'UTC'", 'SET a = 1']);
  });

  it('names the time zone the server refused', async () => {
    const one = session();
    one.failExecuteWhen = (sql) => sql.startsWith('SET time_zone');
    await expect(
      setUpSession(one, { ...mysql, options: { timeZone: 'Mars/Base' } }, mysqlDialect),
    ).rejects.toMatchObject({
      code: 'permission-denied',
      message: expect.stringContaining('refused the time zone "Mars/Base"') as unknown,
    });
  });

  it('names the init statement that failed and stops there', async () => {
    const one = session();
    one.failExecuteWhen = (sql) => sql === 'SET b = 2';
    await expect(
      setUpSession(
        one,
        { ...mysql, options: { initSql: 'SET a = 1; SET b = 2; SET c = 3' } },
        mysqlDialect,
      ),
    ).rejects.toThrow('Init SQL failed at "SET b = 2"');
    expect(one.executed).toEqual(['SET a = 1', 'SET b = 2']);
  });
});
