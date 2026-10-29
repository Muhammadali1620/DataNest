import { describe, expect, it } from 'vitest';
import { readMssqlTableDump } from '../../../../src/drivers/mssql/dump-definitions';

function catalog(answers: Record<string, unknown[][]>) {
  const read = (sql: string) => {
    const key = Object.keys(answers).find((phrase) => sql.includes(phrase));
    return Promise.resolve(key === undefined ? [] : (answers[key] ?? []));
  };
  return { read };
}

describe('readMssqlTableDump', () => {
  it('puts keys and triggers after the rows and owns the triggers', async () => {
    const { read } = catalog({
      "OBJECT_ID(@p1, N'U')": [[1]],
      'sys.identity_columns': [
        ['id', 'int', false, false, null, null, null, false, null, null, null, 'x', false],
      ],
      'FROM sys.triggers tr WHERE tr.parent_id': [
        ['tr_a', 'CREATE TRIGGER tr_a ON t AFTER INSERT AS SELECT 1'],
      ],
    });
    const dump = await readMssqlTableDump(
      read,
      { schema: 'app', name: 't' },
      {
        listForeignKeys: () =>
          Promise.resolve([
            { name: 'fk', columns: ['id'], target: { name: 'u' }, targetColumns: ['id'] },
          ]),
      },
    );
    expect(dump).toEqual({
      before: [],
      create: ['CREATE TABLE [app].[t] (\n  [id] int NOT NULL\n)'],
      after: [
        'ALTER TABLE [app].[t] ADD CONSTRAINT [fk] FOREIGN KEY ([id]) REFERENCES [app].[u] ([id])',
        'CREATE TRIGGER tr_a ON t AFTER INSERT AS SELECT 1',
      ],
      owns: [{ kind: 'trigger', schema: 'app', name: 'tr_a', table: 't' }],
    });
  });

  it('owns triggers in dbo when the table names no schema', async () => {
    const { read } = catalog({
      "OBJECT_ID(@p1, N'U')": [[1]],
      'FROM sys.triggers tr WHERE tr.parent_id': [
        ['tr', 'CREATE TRIGGER tr ON t AFTER INSERT AS SELECT 1'],
      ],
    });
    const dump = await readMssqlTableDump(
      read,
      { name: 't' },
      { listForeignKeys: () => Promise.resolve([]) },
    );
    expect(dump.owns).toEqual([{ kind: 'trigger', schema: 'dbo', name: 'tr', table: 't' }]);
  });

  it('passes on a missing table', async () => {
    await expect(
      readMssqlTableDump(
        catalog({}).read,
        { name: 'x' },
        { listForeignKeys: () => Promise.resolve([]) },
      ),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
