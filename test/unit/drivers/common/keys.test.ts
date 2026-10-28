import { describe, expect, it } from 'vitest';
import {
  EXPRESSION_PART,
  groupForeignKeys,
  groupIndexes,
  groupKeys,
} from '../../../../src/drivers/common/keys';

describe('groupKeys', () => {
  it('groups rows by index and keeps column order', () => {
    expect(
      groupKeys([
        ['a', 'x'],
        ['a', 'y'],
        ['b', 'z'],
      ]),
    ).toEqual([['x', 'y'], ['z']]);
  });

  it('drops an index with an expression column whole', () => {
    expect(
      groupKeys([
        ['a', 'x'],
        ['a', undefined],
        ['b', 'z'],
      ]),
    ).toEqual([['z']]);
  });

  it('keeps an index dropped when more of its columns follow the expression', () => {
    expect(
      groupKeys([
        ['a', 'x'],
        ['a', undefined],
        ['a', 'y'],
      ]),
    ).toEqual([]);
  });

  it('ignores rows without an index name and returns nothing for no rows', () => {
    expect(groupKeys([[undefined, 'x']])).toEqual([]);
    expect(groupKeys([])).toEqual([]);
  });
});

describe('groupForeignKeys', () => {
  const row = (
    id: string | undefined,
    column: string | undefined,
    table: string | undefined,
    targetColumn: string | undefined,
  ) => ({
    id,
    name: id === undefined ? undefined : `fk_${id}`,
    column,
    target: table === undefined ? undefined : { name: table },
    targetColumn,
  });

  it('groups column pairs by constraint and keeps their order', () => {
    expect(
      groupForeignKeys([
        row('1', 'a', 'parent', 'x'),
        row('1', 'b', 'parent', 'y'),
        row('2', 'c', 'other', 'z'),
      ]),
    ).toEqual([
      { name: 'fk_1', columns: ['a', 'b'], target: { name: 'parent' }, targetColumns: ['x', 'y'] },
      { name: 'fk_2', columns: ['c'], target: { name: 'other' }, targetColumns: ['z'] },
    ]);
  });

  it('falls back to the id when a constraint has no name', () => {
    const [key] = groupForeignKeys([{ ...row('7', 'a', 't', 'x'), name: undefined }]);
    expect(key?.name).toBe('7');
  });

  it('drops a constraint with a missing part, and keeps it dropped when more rows follow', () => {
    expect(
      groupForeignKeys([
        row('1', 'a', 'p', 'x'),
        row('1', 'b', 'p', undefined),
        row('1', 'c', 'p', 'z'),
        row('2', 'd', 'p', 'w'),
      ]).map((key) => key.name),
    ).toEqual(['fk_2']);
  });

  it('drops a constraint that names two target tables', () => {
    expect(groupForeignKeys([row('1', 'a', 'p', 'x'), row('1', 'b', 'q', 'y')])).toEqual([]);
  });

  it('ignores rows without a constraint id and handles nothing', () => {
    expect(groupForeignKeys([row(undefined, 'a', 'p', 'x')])).toEqual([]);
    expect(groupForeignKeys([])).toEqual([]);
  });
});

describe('groupIndexes', () => {
  it('groups key parts by index in the order they arrive', () => {
    expect(
      groupIndexes([
        { name: 'PRIMARY', column: 'id', unique: true, primary: true, method: 'BTREE' },
        { name: 'ix_ab', column: 'b', unique: false, primary: false },
        { name: 'ix_ab', column: 'a', unique: false, primary: false },
      ]),
    ).toEqual([
      { name: 'PRIMARY', columns: ['id'], unique: true, primary: true, method: 'BTREE' },
      { name: 'ix_ab', columns: ['b', 'a'], unique: false, primary: false },
    ]);
  });

  it('shows an expression part it cannot print as a placeholder', () => {
    expect(
      groupIndexes([
        { name: 'ix', column: undefined, unique: false, primary: false },
        { name: 'ix', column: 'a', unique: false, primary: false },
      ]),
    ).toEqual([{ name: 'ix', columns: [EXPRESSION_PART, 'a'], unique: false, primary: false }]);
  });

  it('treats a primary key as unique and keeps a partial condition', () => {
    expect(
      groupIndexes([
        { name: 'pk', column: 'id', unique: false, primary: true },
        { name: 'p', column: 'a', unique: true, primary: false, where: 'a > 0', method: '' },
      ]),
    ).toEqual([
      { name: 'pk', columns: ['id'], unique: true, primary: true },
      { name: 'p', columns: ['a'], unique: true, primary: false, where: 'a > 0' },
    ]);
  });

  it('skips rows without an index name and is empty for no rows', () => {
    expect(groupIndexes([{ name: undefined, column: 'a', unique: false, primary: false }])).toEqual(
      [],
    );
    expect(groupIndexes([])).toEqual([]);
  });
});
