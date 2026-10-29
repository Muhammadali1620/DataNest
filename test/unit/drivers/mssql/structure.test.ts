import { describe, expect, it } from 'vitest';
import type { ForeignKey, IndexInfo } from '../../../../src/core/model/objects';
import {
  mssqlReferentialAction,
  readMssqlStructure,
} from '../../../../src/drivers/mssql/structure';

function catalog(answers: Record<string, unknown[][]>) {
  const asked: { sql: string; params: readonly (string | number)[] | undefined }[] = [];
  const read = (sql: string, params?: readonly (string | number)[]) => {
    asked.push({ sql, params });
    const key = Object.keys(answers).find((phrase) => sql.includes(phrase));
    return Promise.resolve(key === undefined ? [] : (answers[key] ?? []));
  };
  return { read, asked };
}

const RELATION = 'FROM sys.tables t WHERE';
const COLUMNS = 'FROM sys.columns c';

const indexes: IndexInfo[] = [
  { name: 'PK_t', columns: ['id', 'part'], unique: true, primary: true },
  { name: 'ix', columns: ['name'], unique: false, primary: false },
];
const foreignKeys: ForeignKey[] = [
  { name: 'fk', columns: ['part'], target: { name: 'parts' }, targetColumns: ['id'] },
];
const reader = {
  listIndexes: () => Promise.resolve(indexes),
  listForeignKeys: () => Promise.resolve(foreignKeys),
};

describe('readMssqlStructure', () => {
  it('reads columns with unwrapped defaults, identities, computed columns and descriptions', async () => {
    const { read, asked } = catalog({
      [RELATION]: [['42', 'Shop table', 'PK_t']],
      [COLUMNS]: [
        ['id', 'int', false, null, true, false, null],
        ['part', 'int', false, '((0))', false, false, 'which part'],
        ['name', 'nvarchar(50)', true, "(N'x')", false, false, ''],
        ['total', 'int', true, null, false, 1, null],
      ],
    });
    const structure = await readMssqlStructure(read, { schema: 'app', name: 't' }, reader);
    expect(structure).toEqual({
      comment: 'Shop table',
      primaryKeyName: 'PK_t',
      primaryKey: ['id', 'part'],
      indexes,
      foreignKeys,
      columns: [
        { name: 'id', dataType: 'int', nullable: false, autoIncrement: true, generated: false },
        {
          name: 'part',
          dataType: 'int',
          nullable: false,
          autoIncrement: false,
          generated: false,
          defaultExpression: '0',
          comment: 'which part',
        },
        {
          name: 'name',
          dataType: 'nvarchar(50)',
          nullable: true,
          autoIncrement: false,
          generated: false,
          defaultExpression: "N'x'",
        },
        { name: 'total', dataType: 'int', nullable: true, autoIncrement: false, generated: true },
      ],
    });
    expect(asked.map((query) => query.params)).toEqual([
      ['[app].[t]', 'MS_Description'],
      ['[app].[t]', 'MS_Description'],
    ]);
  });

  it('leaves out an empty description and an unnamed key, and has no key without a PK', async () => {
    const { read } = catalog({ [RELATION]: [['42', '', null]], [COLUMNS]: [] });
    const structure = await readMssqlStructure(
      read,
      { name: 't' },
      {
        listIndexes: () => Promise.resolve([]),
        listForeignKeys: () => Promise.resolve([]),
      },
    );
    expect(structure).toEqual({ columns: [], primaryKey: [], indexes: [], foreignKeys: [] });
  });

  it('says not-found for a table that does not exist', async () => {
    await expect(
      readMssqlStructure(catalog({}).read, { name: 'nope' }, reader),
    ).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('mssqlReferentialAction', () => {
  it('reads the catalog words as SQL words', () => {
    expect(mssqlReferentialAction('NO_ACTION')).toBe('NO ACTION');
    expect(mssqlReferentialAction('CASCADE')).toBe('CASCADE');
    expect(mssqlReferentialAction('SET_NULL')).toBe('SET NULL');
    expect(mssqlReferentialAction('SET_DEFAULT')).toBe('SET DEFAULT');
  });

  it('knows nothing of other words', () => {
    expect(mssqlReferentialAction(undefined)).toBeUndefined();
    expect(mssqlReferentialAction('RESTRICT')).toBeUndefined();
    expect(mssqlReferentialAction('toString')).toBeUndefined();
  });
});
