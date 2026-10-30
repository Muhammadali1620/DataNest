import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { postgresDialect } from '../../../../src/drivers/postgres/dialect';
import { sqliteDialect } from '../../../../src/drivers/sqlite/dialect';
import type { CellValue } from '../../../../src/shared/cell-value';
import {
  DataCompareModel,
  type DataCompareSide,
} from '../../../../src/vscode/panels/data-compare-model';
import { structure } from '../../../helpers/schema-snapshots';
import { tableSession } from '../../../helpers/table-session';

function side(rows: CellValue[][], overrides: Partial<DataCompareSide> = {}): DataCompareSide {
  const fake = tableSession(rows);
  return {
    label: 'side',
    table: { name: 'items' },
    dialect: sqliteDialect,
    driver: 'sqlite',
    structure: structure(['id integer*', 'name text', 'doc text']),
    session: () => Promise.resolve(fake.session),
    release: () => Promise.resolve(),
    ...overrides,
  };
}

function model(
  source: CellValue[][],
  target: CellValue[][],
  targetOverrides: Partial<DataCompareSide> = {},
) {
  return new DataCompareModel({
    source: side(source, { label: 'src · items' }),
    target: side(target, { label: 'dst · items', ...targetOverrides }),
    key: [{ source: 'id', target: 'id' }],
    columns: [
      { source: 'name', target: 'name' },
      { source: 'doc', target: 'doc' },
    ],
    sourceOnly: ['only_src'],
    targetOnly: [],
    transactions: true,
  });
}

describe('DataCompareModel', () => {
  it('shows the pairs before running and the counts after', async () => {
    const compared = model(
      [
        [1, 'a', '{"x":1}'],
        [2, 'b', null],
      ],
      [
        [1, 'A', '{"x":1}'],
        [3, 'c', null],
      ],
    );
    expect(compared.loaded).toBe(false);
    expect(compared.state()).toMatchObject({ source: 'src · items', sourceOnly: ['only_src'] });
    expect(compared.state().result).toBeUndefined();
    const progress = vi.fn();
    await compared.run({ onProgress: progress });
    expect(compared.loaded).toBe(true);
    expect(compared.state().result).toMatchObject({
      same: 0,
      different: 1,
      onlySource: 1,
      onlyTarget: 1,
      kept: { different: 1, onlySource: 1, onlyTarget: 1 },
    });
    expect(compared.state().progress).toBeUndefined();
  });

  it('gives rows as texts, NULL as null, and marks the cells that differ', async () => {
    const compared = model([[1, 'a', null]], [[1, 'A', null]]);
    await compared.run();
    expect(compared.rows('different', 0, 10)).toEqual([
      { cells: ['1', 'a', null], target: ['1', 'A', null], differs: [false, true, false] },
    ]);
    expect(compared.rows('onlySource', 0, 10)).toEqual([]);
  });

  it('reads JSON kept as text by the type of the other side', async () => {
    const compared = model(
      [[1, 'a', '{"b":1,"a":2}']],
      [[1, 'a', { kind: 'json', text: '{"a": 2, "b": 1}' }]],
      {
        structure: structure(['id int*', 'name text', 'doc jsonb']),
        driver: 'postgres',
        dialect: postgresDialect,
      },
    );
    await compared.run();
    expect(compared.state().result?.same).toBe(1);
  });

  it('pages through kept rows and cuts long texts', async () => {
    const rows = Array.from({ length: 5 }, (_, index): CellValue[] => [
      index,
      'x'.repeat(3000),
      null,
    ]);
    const compared = model(rows, []);
    await compared.run();
    const page = compared.rows('onlySource', 2, 2);
    expect(page.map((row) => row.cells[0])).toEqual(['2', '3']);
    expect(page[0]?.cells[1]?.length).toBe(2001);
    expect(page[0]?.cells[1]?.endsWith('…')).toBe(true);
  });

  it('writes the sync script for the target', async () => {
    const compared = model(
      [
        [1, 'a', null],
        [2, 'b', null],
      ],
      [
        [1, 'A', null],
        [3, 'c', null],
      ],
    );
    expect(compared.script({ insert: true, update: true, delete: true }, new Date(0))).toContain(
      'Nothing to change.',
    );
    await compared.run();
    const script = compared.script({ insert: true, update: true, delete: true }, new Date(0));
    expect(script).toContain(`INSERT INTO "items" ("id", "name", "doc") VALUES\n(2, 'b', NULL);`);
    expect(script).toContain(`UPDATE "items" SET "name" = 'a' WHERE "id" = 1;`);
    expect(script).toContain('DELETE FROM "items" WHERE "id" = 3;');
  });

  it('keeps the error of a failed comparison and passes a cancel on', async () => {
    const failing = model(
      [
        [1, 'a', null],
        [1, 'b', null],
      ],
      [],
    );
    await failing.run();
    expect(failing.state().error).toContain('repeat in the source');
    expect(failing.loaded).toBe(true);
    const cancelled = new DataCompareModel({
      source: side([], { session: () => Promise.reject(new DbError('cancelled', 'stop')) }),
      target: side([]),
      key: [{ source: 'id', target: 'id' }],
      columns: [],
      sourceOnly: [],
      targetOnly: [],
      transactions: false,
    });
    await expect(cancelled.run()).rejects.toMatchObject({ code: 'cancelled' });
    expect(cancelled.state().error).toBeUndefined();
  });
});
