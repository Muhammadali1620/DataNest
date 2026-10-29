import { describe, expect, it } from 'vitest';
import { driver } from '../../../../src/drivers/clickhouse';
import { clickhouseDialect } from '../../../../src/drivers/clickhouse/dialect';

describe('clickhouse driver', () => {
  it('describes ClickHouse: databases without schemas, no transactions, cancel', () => {
    expect(driver.id).toBe('clickhouse');
    expect(driver.dialect).toBe(clickhouseDialect);
    expect(driver.capabilities).toEqual({
      databases: true,
      schemas: false,
      databaseScopedSessions: false,
      cancel: true,
      transactions: false,
      objectKinds: [],
    });
    expect(typeof driver.openSession).toBe('function');
  });
});
