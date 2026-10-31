import { describe, expect, it } from 'vitest';
import {
  mysqlDefaultExpression,
  readMysqlStructure,
} from '../../../../src/drivers/mysql/structure';

describe('mysqlDefaultExpression', () => {
  it('has no default where the server reports NULL', () => {
    expect(mysqlDefaultExpression(undefined, '', 'varchar', false)).toBeUndefined();
    expect(mysqlDefaultExpression('NULL', '', 'varchar', true)).toBeUndefined();
  });

  it('quotes a MySQL text value and leaves numbers and bits bare', () => {
    expect(mysqlDefaultExpression("it's", '', 'varchar', false)).toBe("'it''s'");
    expect(mysqlDefaultExpression('a\\b', '', 'text', false)).toBe("'a\\\\b'");
    expect(mysqlDefaultExpression('0.00', '', 'decimal', false)).toBe('0.00');
    expect(mysqlDefaultExpression('5', '', 'INT', false)).toBe('5');
    expect(mysqlDefaultExpression("b'101'", '', 'bit', false)).toBe("b'101'");
    // A date is text to MySQL, so it needs quotes.
    expect(mysqlDefaultExpression('2024-01-01', '', 'date', false)).toBe("'2024-01-01'");
  });

  it('writes MySQL expression defaults bare or in parentheses', () => {
    expect(
      mysqlDefaultExpression('CURRENT_TIMESTAMP', 'DEFAULT_GENERATED', 'datetime', false),
    ).toBe('CURRENT_TIMESTAMP');
    expect(mysqlDefaultExpression('now(3)', 'DEFAULT_GENERATED', 'datetime', false)).toBe('now(3)');
    expect(mysqlDefaultExpression('uuid()', 'DEFAULT_GENERATED', 'varchar', false)).toBe(
      '(uuid())',
    );
  });

  it('takes the MariaDB value as the expression it already is', () => {
    expect(mysqlDefaultExpression("'it''s'", '', 'varchar', true)).toBe("'it''s'");
    expect(mysqlDefaultExpression('current_timestamp()', '', 'datetime', true)).toBe(
      'current_timestamp()',
    );
  });

  it('keeps ON UPDATE with the default, so a rewrite does not lose it', () => {
    expect(
      mysqlDefaultExpression(
        'CURRENT_TIMESTAMP',
        'DEFAULT_GENERATED on update CURRENT_TIMESTAMP',
        'timestamp',
        false,
      ),
    ).toBe('CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP');
    expect(
      mysqlDefaultExpression(undefined, 'on update current_timestamp(3)', 'datetime', true),
    ).toBe('NULL ON UPDATE current_timestamp(3)');
  });
});

describe('readMysqlStructure: checks', () => {
  const reader = {
    listIndexes: () => Promise.resolve([]),
    listForeignKeys: () => Promise.resolve([]),
  };

  function server(version: string, checks: unknown[][] | Error) {
    const asked: string[] = [];
    const read = (sql: string): Promise<unknown[][]> => {
      asked.push(sql);
      if (sql.includes('FROM information_schema.COLUMNS')) {
        return Promise.resolve([['id', 'int', 'NO', null, '', '', 'int']]);
      }
      if (sql.includes('SELECT VERSION()')) {
        return Promise.resolve([[version]]);
      }
      if (sql.includes('CHECK_CONSTRAINTS')) {
        return checks instanceof Error ? Promise.reject(checks) : Promise.resolve(checks);
      }
      return Promise.resolve([]);
    };
    return { read, asked };
  }

  it('reads checks of MySQL through the table constraints', async () => {
    const { read, asked } = server('8.0.36', [['ck', '(`id` > 0)']]);
    const structure = await readMysqlStructure(read, { database: 's', name: 't' }, reader);
    expect(structure.checks).toEqual([{ name: 'ck', expression: '(`id` > 0)' }]);
    expect(asked.some((sql) => sql.includes('TABLE_CONSTRAINTS'))).toBe(true);
  });

  it('reads checks of MariaDB straight from its view', async () => {
    const { read, asked } = server('10.11.2-MariaDB', [['ck', '`id` > 0']]);
    const structure = await readMysqlStructure(read, { name: 't' }, reader);
    expect(structure.checks).toEqual([{ name: 'ck', expression: '`id` > 0' }]);
    expect(asked.some((sql) => sql.includes('TABLE_CONSTRAINTS'))).toBe(false);
  });

  it('shows no checks on a server that has no such view', async () => {
    const { read } = server('5.7.40', new Error("Table 'CHECK_CONSTRAINTS' doesn't exist"));
    const structure = await readMysqlStructure(read, { name: 't' }, reader);
    expect(structure.checks).toEqual([]);
  });
});
