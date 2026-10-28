import { describe, expect, it } from 'vitest';
import { pgReferentialAction } from '../../../../src/drivers/postgres/structure';

describe('pgReferentialAction', () => {
  it('turns the catalog letters into SQL words', () => {
    expect(['a', 'r', 'c', 'n', 'd'].map((code) => pgReferentialAction(code))).toEqual([
      'NO ACTION',
      'RESTRICT',
      'CASCADE',
      'SET NULL',
      'SET DEFAULT',
    ]);
  });

  it('knows nothing of other letters', () => {
    expect(pgReferentialAction('x')).toBeUndefined();
    expect(pgReferentialAction(undefined)).toBeUndefined();
    expect(pgReferentialAction('toString')).toBeUndefined();
  });
});
