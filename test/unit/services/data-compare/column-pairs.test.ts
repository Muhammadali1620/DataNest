import { describe, expect, it } from 'vitest';
import {
  columnModes,
  pairColumns,
  targetTypes,
  writableColumns,
  writesIdentity,
} from '../../../../src/services/data-compare/column-pairs';
import { structure } from '../../../helpers/schema-snapshots';

describe('pairColumns', () => {
  it('pairs columns by name, exactly first and then ignoring case', () => {
    const plan = pairColumns(
      structure(['id int*', 'Name text', 'name2 text', 'only_src int']),
      structure(['ID int*', 'name text', 'name2 text', 'only_dst int']),
    );
    expect(plan.pairs).toEqual([
      { source: 'id', target: 'ID' },
      { source: 'Name', target: 'name' },
      { source: 'name2', target: 'name2' },
    ]);
    expect(plan.sourceOnly).toEqual(['only_src']);
    expect(plan.targetOnly).toEqual(['only_dst']);
    expect(plan.key).toEqual([{ source: 'id', target: 'ID' }]);
  });

  it('prefers an exact match over one that only differs in case', () => {
    const plan = pairColumns(structure(['a int', 'A int']), structure(['A int']));
    expect(plan.pairs).toEqual([{ source: 'A', target: 'A' }]);
  });

  it('falls back to the target key, then a unique index, then nothing', () => {
    expect(
      pairColumns(structure(['id int', 'n int']), structure(['id int*', 'n int'])).key,
    ).toEqual([{ source: 'id', target: 'id' }]);
    const unique = pairColumns(
      structure(['code text', 'n int'], {
        indexes: [
          { name: 'partial', columns: ['n'], unique: true, primary: false, where: 'n > 0' },
          { name: 'u_code', columns: ['code'], unique: true, primary: false },
        ],
      }),
      structure(['code text', 'n int']),
    );
    expect(unique.key).toEqual([{ source: 'code', target: 'code' }]);
    expect(pairColumns(structure(['a int']), structure(['a int'])).key).toEqual([]);
  });

  it('cannot use a key whose columns are not in both tables', () => {
    expect(pairColumns(structure(['id int*', 'n int']), structure(['n int'])).key).toEqual([]);
  });
});

describe('column helpers', () => {
  const target = structure(['id int*', 'doc jsonb', 'at timestamp', 'total int'], {
    generated: ['total'],
  });

  it('never writes computed columns', () => {
    expect([...writableColumns(target)]).toEqual(['id', 'doc', 'at']);
  });

  it('notices an auto-numbered column among the written ones', () => {
    const auto = {
      ...target,
      columns: target.columns.map((column) => ({ ...column, autoIncrement: column.name === 'id' })),
    };
    expect(writesIdentity(auto, ['id', 'doc'])).toBe(true);
    expect(writesIdentity(auto, ['doc'])).toBe(false);
  });

  it('reads JSON and dates from either side, for comparing and writing', () => {
    const pairs = [
      { source: 'doc', target: 'doc' },
      { source: 'at', target: 'at' },
      { source: 'id', target: 'id' },
    ];
    const sqlite = structure(['id integer*', 'doc text', 'at text']);
    expect(
      columnModes(
        pairs,
        { structure: sqlite, driver: 'sqlite' },
        { structure: target, driver: 'postgres' },
      ),
    ).toEqual(['json', 'datetime', 'plain']);
    expect(targetTypes(pairs, target, 'postgres').map((type) => type.kind)).toEqual([
      'json',
      'datetime',
      'integer',
    ]);
  });
});
