// CHECK constraints on a real Oracle: NOT NULL columns are left out, named and unnamed
// checks are listed with their condition, and the page's ALTER TABLE adds and drops them.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Session } from '../../../src/drivers/driver';
import { driver as oracleDriver } from '../../../src/drivers/oracle';
import { checkPlanFor } from '../../../src/services/table-checks';
import { ORACLE_SERVICE, testDatabase } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';

describe('oracle checks', () => {
  let session: Session;
  const table = { schema: 'DATANEST', name: 'DN_CHECKS' };

  async function checks(): Promise<{ name: string; expression: string }[]> {
    const structure = await session.metadata.describeTable(table);
    return [...(structure.checks ?? [])];
  }

  beforeAll(async () => {
    const db = testDatabase('oracle');
    session = await oracleDriver.openSession({
      id: 'checks-oracle',
      name: 'oracle',
      driver: 'oracle',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: ORACLE_SERVICE,
    });
    await runAll(session, 'DROP TABLE IF EXISTS dn_checks PURGE');
    await runAll(
      session,
      `CREATE TABLE dn_checks (
         id NUMBER NOT NULL,
         price NUMBER CHECK (price > 0),
         qty NUMBER,
         CONSTRAINT qty_ok CHECK (qty >= 0 AND qty < 1000)
       )`,
    );
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS dn_checks PURGE');
    await session.close();
  });

  it('lists the checks and leaves the NOT NULL of a column out', async () => {
    const found = await checks();
    expect(found.map((check) => check.expression).sort()).toEqual([
      '(price > 0)',
      '(qty >= 0 AND qty < 1000)',
    ]);
    expect(found.some((check) => check.name === 'QTY_OK')).toBe(true);
  });

  it('adds a check through ALTER TABLE and drops it again', async () => {
    const dialect = oracleDriver.dialect;
    const add = checkPlanFor(dialect, table, undefined, {
      action: 'add',
      name: 'price_small',
      expression: 'price < 1000000',
    });
    for (const statement of add.statements) {
      await runAll(session, statement);
    }
    expect((await checks()).map((check) => check.name)).toContain('price_small');
    await expect(
      runAll(session, 'INSERT INTO dn_checks (id, price) VALUES (1, 5000000)'),
    ).rejects.toThrow();
    const drop = checkPlanFor(dialect, table, undefined, { action: 'drop', name: 'price_small' });
    for (const statement of drop.statements) {
      await runAll(session, statement);
    }
    expect((await checks()).map((check) => check.name)).not.toContain('price_small');
    await runAll(session, 'INSERT INTO dn_checks (id, price) VALUES (1, 5000000)');
  });
});
