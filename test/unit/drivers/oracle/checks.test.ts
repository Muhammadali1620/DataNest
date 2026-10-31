import { describe, expect, it } from 'vitest';
import { oracleChecks } from '../../../../src/drivers/oracle/checks';

describe('oracleChecks', () => {
  it('lists real checks and leaves out the NOT NULL ones of columns', () => {
    expect(
      oracleChecks([
        ['SYS_C001', '"ID" IS NOT NULL'],
        ['SYS_C002', 'name is not null'],
        ['SYS_C003', '"A B" IS  NOT   NULL'],
        ['CK_PRICE', 'price > 0'],
        ['SYS_C004', 'qty >= 0 AND qty IS NOT NULL'],
        ['CK_NAME_NOT_NULL', 'name IS NOT NULL AND length(name) > 1'],
      ]),
    ).toEqual([
      { name: 'CK_PRICE', expression: '(price > 0)' },
      { name: 'SYS_C004', expression: '(qty >= 0 AND qty IS NOT NULL)' },
      { name: 'CK_NAME_NOT_NULL', expression: '(name IS NOT NULL AND length(name) > 1)' },
    ]);
  });

  it('skips rows without a name or condition and trims the condition', () => {
    expect(oracleChecks([[null, 'a > 1'], ['CK', null], ['CK2', '  a > 1 \n'], ['CK3']])).toEqual([
      { name: 'CK2', expression: '(a > 1)' },
    ]);
    expect(oracleChecks([])).toEqual([]);
  });
});
