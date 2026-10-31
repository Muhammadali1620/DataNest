import { describe, expect, it } from 'vitest';
import {
  chooseKey,
  comparesExactly,
  findByName,
  isSpatial,
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
      columns: [
        { name: 'id', dataType: 'int', nullable: false, kind: 'integer' },
        { name: 'Name', dataType: 'int', nullable: true, kind: 'integer' },
        { name: 'email', dataType: 'int', nullable: false, kind: 'integer' },
      ],
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

  it('finds rows of a table without a usable key by all their values (V10.2.4)', () => {
    const columns = [column('a'), column('b', { nullable: true })];
    const result = resolveEditability(
      input({ columns, uniqueKeys: [['b']], resultColumns: ['a', 'b'] }),
    );
    expect(result).toMatchObject({
      editable: true,
      keyColumns: ['a', 'b'],
      keyIndexes: [0, 1],
      keyless: true,
    });
  });

  it('leaves out of that "key" the columns whose values do not compare exactly', () => {
    const columns = [
      column('id'),
      column('price', { dataType: 'double precision' }),
      column('photo', { dataType: 'blob' }),
      column('doc', { dataType: 'jsonb' }),
      column('note', { dataType: 'clob' }),
      column('name', { dataType: 'varchar(20)' }),
    ];
    const result = resolveEditability(
      input({ columns, resultColumns: ['id', 'price', 'photo', 'doc', 'note', 'name'] }),
    );
    expect(result).toMatchObject({ keyColumns: ['id', 'name'], keyIndexes: [0, 5] });
  });

  it('is read-only without a key when the result does not show the whole row', () => {
    const columns = [column('a'), column('b')];
    const result = resolveEditability(
      input({ columns, items: [{ kind: 'column', name: 'a', output: 'a' }], resultColumns: ['a'] }),
    );
    expect(result).toEqual(readOnlyResult('no-key'));
  });

  it('never edits a ClickHouse table by its values: it cannot count the rows it changed', () => {
    const columns = [column('a'), column('b')];
    const result = resolveEditability(
      input({ columns, resultColumns: ['a', 'b'], driver: 'clickhouse' }),
    );
    expect(result).toEqual(readOnlyResult('no-key'));
  });

  it('is read-only without a key when no column compares exactly', () => {
    const columns = [column('x', { dataType: 'real' }), column('y', { dataType: 'json' })];
    const result = resolveEditability(input({ columns, resultColumns: ['x', 'y'] }));
    expect(result).toEqual(readOnlyResult('no-key'));
  });

  it('marks only a result found by its values as keyless', () => {
    const result = resolveEditability(input());
    expect(result).toMatchObject({ editable: true, keyColumns: ['id'] });
    expect(result.editable && result.keyless).toBe(undefined);
  });

  it('is read-only when the key is binary, since it cannot be written back exactly', () => {
    const columns = [column('id', { primaryKey: true, dataType: 'binary(16)' }), column('v')];
    const result = resolveEditability(
      input({ columns, items: [{ kind: 'star' }], resultColumns: ['id', 'v'] }),
    );
    expect(result).toEqual(readOnlyResult('no-key'));
  });

  it('carries the default of a column to the editor', () => {
    const columns = [
      column('id', { primaryKey: true }),
      column('created', { defaultValue: 'CURRENT_TIMESTAMP', nullable: true }),
    ];
    const result = resolveEditability(input({ columns, resultColumns: ['id', 'created'] }));
    expect(result).toMatchObject({
      editable: true,
      columns: [{ name: 'id' }, { name: 'created', defaultValue: 'CURRENT_TIMESTAMP' }],
    });
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

describe('comparesExactly', () => {
  it('trusts = on whole numbers, decimals, text, dates and booleans', () => {
    for (const type of [
      'int',
      'bigint',
      'decimal(10,2)',
      'numeric',
      'varchar(5)',
      'text',
      'date',
      'timestamp with time zone',
      'boolean',
      "enum('a','b')",
      'uuid',
    ]) {
      expect(comparesExactly(type), type).toBe(true);
    }
  });

  it('does not trust = on floats, binaries, JSON, large objects and shapes', () => {
    for (const type of [
      'float',
      'double',
      'real',
      'float8',
      'bytea',
      'varbinary(16)',
      'json',
      'jsonb',
      'clob',
      'nclob',
      'long',
      'xml',
      'geometry',
      'point',
      'tsvector',
    ]) {
      expect(comparesExactly(type), type).toBe(false);
    }
  });

  it('knows the large types SQL Server cannot compare, and only there', () => {
    for (const type of ['text', 'ntext', 'image', 'timestamp']) {
      expect(comparesExactly(type, 'mssql'), type).toBe(false);
    }
    expect(comparesExactly('text', 'postgres')).toBe(true);
    expect(comparesExactly('timestamp', 'mysql')).toBe(true);
  });
});

describe('spatial columns (V10.2.4)', () => {
  it('shows them but does not edit them as text, on MySQL', () => {
    const columns = [
      column('id', { primaryKey: true }),
      column('place', { dataType: 'point' }),
      column('area', { dataType: 'polygon' }),
    ];
    const result = resolveEditability(
      input({ columns, resultColumns: ['id', 'place', 'area'], driver: 'mysql' }),
    );
    expect(result).toMatchObject({ editable: true, columnMap: ['id', 'place', 'area'] });
    expect(result.editable && result.columns).toEqual([expect.anything(), null, null]);
  });

  it('knows PostgreSQL’s own geometric types from PostGIS ones', () => {
    expect(isSpatial('point', 'postgres')).toBe(false);
    expect(isSpatial('polygon', 'postgres')).toBe(false);
    expect(isSpatial('geometry(Point,4326)', 'postgres')).toBe(true);
    expect(isSpatial('geography', 'postgres')).toBe(true);
    for (const type of ['geometry', 'POINT', 'linestring', 'multipolygon', 'geomcollection']) {
      expect(isSpatial(type, 'mysql'), type).toBe(true);
    }
    expect(isSpatial('varchar(10)', 'mysql')).toBe(false);
    expect(isSpatial('pointer', 'mysql')).toBe(false);
  });

  it('never puts them in the match of a keyless row', () => {
    for (const type of ['geometry', 'point', 'multipoint', 'geomcollection', 'multilinestring']) {
      expect(comparesExactly(type, 'mysql'), type).toBe(false);
    }
  });
});
