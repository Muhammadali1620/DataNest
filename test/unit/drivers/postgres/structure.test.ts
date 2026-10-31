import { describe, expect, it } from 'vitest';
import { pgReferentialAction, readPgStructure } from '../../../../src/drivers/postgres/structure';

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

describe('readPgStructure: checks', () => {
  const reader = {
    listIndexes: () => Promise.resolve([]),
    listForeignKeys: () => Promise.resolve([]),
  };

  it('reads the CHECK constraints with the condition as the server prints it', async () => {
    const read = Object.assign(
      (sql: string) => {
        if (sql.includes('FROM pg_class')) {
          return Promise.resolve([['16384', null, null]]);
        }
        if (sql.includes("contype = 'c'")) {
          return Promise.resolve([['ck_price', 'CHECK ((price > 0))']]);
        }
        return Promise.resolve([]);
      },
      { server: 'postgres' },
    );
    const structure = await readPgStructure(read as never, { schema: 'public', name: 't' }, reader);
    expect(structure.checks).toEqual([{ name: 'ck_price', expression: 'CHECK ((price > 0))' }]);
  });
});
