import { describe, expect, it } from 'vitest';
import type { TableStructure } from '../../../../src/core/model/objects';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import type { ImportRequest, ImportReport } from '../../../../src/services/import/table-import';
import { TestDataModel } from '../../../../src/vscode/panels/test-data-model';
import { FakeSession } from '../../../helpers/fake-driver';

const STRUCTURE: TableStructure = {
  columns: [
    { name: 'id', dataType: 'integer', nullable: false, autoIncrement: true, generated: false },
    {
      name: 'name',
      dataType: 'varchar(40)',
      nullable: false,
      autoIncrement: false,
      generated: false,
    },
    {
      name: 'owner_id',
      dataType: 'integer',
      nullable: false,
      autoIncrement: false,
      generated: false,
    },
    { name: 'size', dataType: 'text', nullable: false, autoIncrement: false, generated: false },
  ],
  primaryKey: ['id'],
  indexes: [],
  foreignKeys: [
    { name: 'fk', columns: ['owner_id'], target: { name: 'owners' }, targetColumns: ['id'] },
  ],
};

function model(references: number[][] = [[3]], requests: ImportRequest[] = []): TestDataModel {
  const session = new FakeSession({ id: 'c', name: 'c', driver: 'postgres' });
  session.rows = references;
  return new TestDataModel({
    target: { connectionId: 'c' },
    table: { name: 'things' },
    driver: 'postgres',
    dialect: postgresDialect,
    structure: STRUCTURE,
    session: () => Promise.resolve(session),
    importer: {
      run: async (request) => {
        requests.push(request);
        let inserted = 0;
        for await (const _record of request.records) {
          inserted += 1;
          request.onProgress?.({ read: inserted, inserted, failed: 0 });
        }
        const report: ImportReport = {
          outcome: 'done',
          read: inserted,
          inserted,
          failedCount: 0,
          failures: [],
          rolledBack: false,
          durationMs: 1,
        };
        return report;
      },
    },
    newSeed: () => 99,
  });
}

describe('TestDataModel', () => {
  it('starts with the suggested generators, 100 rows and a seed', () => {
    const state = model().initialState('public.things');
    expect(state).toMatchObject({
      driver: 'postgres',
      table: 'public.things',
      count: 100,
      seed: 99,
    });
    expect(state.choices.map((choice) => choice.generator)).toEqual([
      'default',
      'fullName',
      'reference',
      'words',
    ]);
    expect(state.columns[0]).toMatchObject({ name: 'id', locked: 'auto', unique: true });
    expect(state.columns[2]?.reference).toBe('owners.id');
  });

  it('previews rows, showing nothing for columns left to the database', async () => {
    const tested = model();
    const preview = await tested.preview(tested.initialState('t').choices, 1);
    expect(preview.rows).toHaveLength(10);
    expect(preview.rows.every((row) => row[0] === null && row[2] === '3')).toBe(true);
    expect(preview.problems).toEqual([]);
  });

  it('names what stands in the way of the choices', async () => {
    const tested = model([]);
    const choices = tested
      .initialState('t')
      .choices.map((choice, index) =>
        index === 1
          ? { generator: 'null' as const, nullPercent: 0 }
          : index === 3
            ? { generator: 'enum' as const, nullPercent: 0 }
            : choice,
      );
    expect((await tested.preview(choices, 1)).problems).toEqual([
      { column: 'name', problem: 'not-nullable' },
      { column: 'owner_id', problem: 'no-references' },
      { column: 'size', problem: 'no-options' },
    ]);
  });

  it('runs the import with every row and reports progress', async () => {
    const requests: ImportRequest[] = [];
    const tested = model([[3]], requests);
    const seen: number[] = [];
    const report = await tested.run(tested.initialState('t').choices, 250, 5, {
      onProgress: (done) => seen.push(done),
    });
    expect(report.inserted).toBe(250);
    expect(seen.at(-1)).toBe(250);
    expect(requests[0]?.mode).toBe('all');
    expect(requests[0]?.columns.map((column) => column.name)).toEqual(['name', 'owner_id', 'size']);
  });

  it('writes the rows as a SQL script', async () => {
    const tested = model();
    const script = await tested.script(tested.initialState('t').choices, 3, 5);
    expect(script.startsWith('INSERT INTO "things" ("name", "owner_id", "size") VALUES\n(')).toBe(
      true,
    );
    expect(script.match(/\),\n\(/gu)).toHaveLength(2);
  });
});
