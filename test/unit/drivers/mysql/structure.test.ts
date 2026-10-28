import { describe, expect, it } from 'vitest';
import { mysqlDefaultExpression } from '../../../../src/drivers/mysql/structure';

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
