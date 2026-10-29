import { describe, expect, it } from 'vitest';
import { driver } from '../../../../src/drivers/oracle';
import { oracleDialect } from '../../../../src/drivers/oracle/dialect';
import { openOracleSession } from '../../../../src/drivers/oracle/session';

describe('oracle driver', () => {
  it('describes Oracle: the service as database, schemas, transactions, cancel', () => {
    expect(driver.id).toBe('oracle');
    expect(driver.dialect).toBe(oracleDialect);
    expect(driver.capabilities).toEqual({
      databases: true,
      schemas: true,
      databaseScopedSessions: true,
      cancel: true,
      transactions: true,
      objectKinds: ['function', 'procedure', 'sequence'],
    });
    expect(driver).toHaveProperty('openSession', openOracleSession);
  });
});
