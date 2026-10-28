import { describe, expect, it } from 'vitest';
import {
  chooseKey,
  findByName,
  readOnlyResult,
  resolveEditability,
  type EditabilityInput,
} from '../../../../src/core/model/editability';
import type { ColumnInfo } from '../../../../src/core/model/objects';

function column(name: string, overrides: Partial<ColumnInfo> = {}): ColumnInfo {
  return { name, dataType: 'int', nullable: false, primaryKey: false, ...overrides };
}

const COLUMNS = [
  column('id', { primaryKey: true }),
  column('Name', { nullable: true }),
  column('email'),
];

function input(overrides: Partial<EditabilityInput> = {}): EditabilityInput {
  return {
    table: { name: 'users' },
    kind: 'table',
    columns: COLUMNS,
    uniqueKeys: [],
    items: [{ kind: 'star' }],
    resultColumns: ['id', 'Name', 'email'],
    ...overrides,
  };
}

describe('findByName', () => {
  it('prefers an exact match and falls back to a unique case-insensitive one', () => {
    const list = [{ name: 'a' }, { name: 'A' }, { name: 'b' }];
    expect(findByName(list, 'A')).toBe(list[1]);
    expect(findByName(list, 'B')).toBe(list[2]);
    expect(findByName(list, 'c')).toBeUndefined();
  });

  it('refuses to guess between names that differ only by case', () => {
    expect(findByName([{ name: 'a' }, { name: 'A' }], 'a')).toBeDefined();
    expect(findByName([{ name: 'ab' }, { name: 'aB' }], 'AB')).toBeUndefined();
  });
});

describe('chooseKey', () => {
  it('uses the primary key, composite included', () => {
    const columns = [
      column('a', { primaryKey: true }),
      column('b', { primaryKey: true }),
      column('c'),
    ];
    expect(chooseKey(columns, [['c']])).toEqual(['a', 'b']);
  });

  it('falls back to the shortest unique key whose columns are not nullable', () => {
    const columns = [column('a'), column('b'), column('n', { nullable: true })];
    expect(chooseKey(columns, [['a', 'b'], ['n'], ['b']])).toEqual(['b']);
  });

  it('matches unique key columns without regard to case', () => {
    expect(chooseKey([column('Email')], [['email']])).toEqual(['email']);
  });

  it('has no key when every candidate can hold NULL or names a missing column', () => {
    expect(chooseKey([column('n', { nullable: true })], [['n']])).toBeUndefined();
    expect(chooseKey([column('a')], [['zzz'], []])).toBeUndefined();
    expect(chooseKey([column('a')], [])).toBeUndefined();
  });
});

describe('resolveEditability', () => {
  it('makes a select * of a table with a primary key editable', () => {
    expect(resolveEditability(input())).toEqual({
      editable: true,
      table: { name: 'users' },
      columnMap: ['id', 'Name', 'email'],
      keyColumns: ['id'],
      keyIndexes: [0],
    });
  });

  it('finds the key wherever it sits in the result', () => {
    const result = resolveEditability(
      input({
        items: [
          { kind: 'column', name: 'email', output: 'email' },
          { kind: 'column', name: 'id', output: 'identifier' },
        ],
        resultColumns: ['email', 'identifier'],
      }),
    );
    expect(result).toMatchObject({ editable: true, keyIndexes: [1], columnMap: ['email', 'id'] });
  });

  it('marks computed columns as not backed by a table column', () => {
    const result = resolveEditability(
      input({
        items: [{ kind: 'column', name: 'id', output: 'id' }, { kind: 'expression' }],
        resultColumns: ['id', 'total'],
      }),
    );
    expect(result).toMatchObject({ editable: true, columnMap: ['id', null] });
  });

  it('treats a name that is not a column (NULL, a constant) as computed', () => {
    const result = resolveEditability(
      input({
        items: [
          { kind: 'column', name: 'id', output: 'id' },
          { kind: 'column', name: 'CURRENT_DATE', output: 'CURRENT_DATE' },
        ],
        resultColumns: ['id', 'CURRENT_DATE'],
      }),
    );
    expect(result).toMatchObject({ editable: true, columnMap: ['id', null] });
  });

  it('is read-only for a view', () => {
    expect(resolveEditability(input({ kind: 'view' }))).toEqual(readOnlyResult('view'));
  });

  it('is read-only when the key columns were not selected', () => {
    const result = resolveEditability(
      input({
        items: [{ kind: 'column', name: 'email', output: 'email' }],
        resultColumns: ['email'],
      }),
    );
    expect(result).toEqual(readOnlyResult('key-not-selected'));
  });

  it('needs every column of a composite key', () => {
    const columns = [column('a', { primaryKey: true }), column('b', { primaryKey: true })];
    const items = [{ kind: 'column', name: 'a', output: 'a' } as const];
    expect(resolveEditability(input({ columns, items, resultColumns: ['a'] }))).toEqual(
      readOnlyResult('key-not-selected'),
    );
  });

  it('is read-only without any usable key', () => {
    const columns = [column('a'), column('b', { nullable: true })];
    const result = resolveEditability(
      input({ columns, uniqueKeys: [['b']], resultColumns: ['a', 'b'] }),
    );
    expect(result).toEqual(readOnlyResult('no-key'));
  });

  it('edits by a unique key when there is no primary key', () => {
    const columns = [column('code'), column('label', { nullable: true })];
    const result = resolveEditability(
      input({ columns, uniqueKeys: [['code']], resultColumns: ['code', 'label'] }),
    );
    expect(result).toMatchObject({ editable: true, keyColumns: ['code'], keyIndexes: [0] });
  });

  it('is read-only when the result has a different number of columns than the statement implies', () => {
    expect(resolveEditability(input({ resultColumns: ['id', 'Name'] }))).toEqual(
      readOnlyResult('columns-mismatch'),
    );
  });

  it('is read-only when a result column carries another name than the statement says', () => {
    expect(resolveEditability(input({ resultColumns: ['id', 'Name', 'surprise'] }))).toEqual(
      readOnlyResult('columns-mismatch'),
    );
  });

  it('compares result column names without regard to case', () => {
    expect(resolveEditability(input({ resultColumns: ['ID', 'name', 'EMAIL'] }))).toMatchObject({
      editable: true,
    });
  });

  it('reports a column selected twice at its first position', () => {
    const result = resolveEditability(
      input({
        items: [
          { kind: 'column', name: 'id', output: 'id' },
          { kind: 'column', name: 'id', output: 'id' },
        ],
        resultColumns: ['id', 'id'],
      }),
    );
    expect(result).toMatchObject({ editable: true, keyIndexes: [0] });
  });
});
