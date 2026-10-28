import { describe, expect, it } from 'vitest';
import {
  type ColumnDesign,
  columnNames,
  composeType,
  type ForeignKeyDesign,
  type IndexDesign,
  designProblems,
  newTableDesign,
  splitType,
  type TableDesign,
} from '../../../src/shared/table-design';

function column(overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  return {
    id: 'c1',
    name: 'name',
    type: 'text',
    length: '',
    nullable: true,
    defaultValue: '',
    autoIncrement: false,
    primaryKey: false,
    comment: '',
    ...overrides,
  };
}

function design(columns: ColumnDesign[], name = 't'): TableDesign {
  return { name, comment: '', columns, indexes: [], foreignKeys: [] };
}

describe('composeType', () => {
  it('puts the length in parentheses after the type', () => {
    expect(composeType('varchar', '255')).toBe('varchar(255)');
    expect(composeType('numeric', ' 10,2 ')).toBe('numeric(10,2)');
    expect(composeType('enum', "'a','b'")).toBe("enum('a','b')");
  });

  it('leaves a type without length alone', () => {
    expect(composeType(' text ', '')).toBe('text');
    expect(composeType('double precision', '  ')).toBe('double precision');
  });

  it('keeps suffixes after the parentheses', () => {
    expect(composeType('decimal unsigned', '10,2')).toBe('decimal(10,2) unsigned');
    expect(composeType('int unsigned zerofill', '5')).toBe('int(5) unsigned zerofill');
    expect(composeType('timestamp with time zone', '3')).toBe('timestamp(3) with time zone');
    expect(composeType('time without time zone', '0')).toBe('time(0) without time zone');
  });
});

describe('splitType', () => {
  it('takes the length out of the parentheses', () => {
    expect(splitType('varchar(255)')).toEqual({ type: 'varchar', length: '255' });
    expect(splitType('numeric(10, 2)')).toEqual({ type: 'numeric', length: '10, 2' });
    expect(splitType('character varying(40)')).toEqual({
      type: 'character varying',
      length: '40',
    });
  });

  it('keeps the suffix with the type', () => {
    expect(splitType('decimal(10,2) unsigned')).toEqual({
      type: 'decimal unsigned',
      length: '10,2',
    });
    expect(splitType('timestamp(3) with time zone')).toEqual({
      type: 'timestamp with time zone',
      length: '3',
    });
  });

  it('reads enum values with parentheses and quotes inside', () => {
    expect(splitType("enum('a)','b')")).toEqual({ type: 'enum', length: "'a)','b'" });
  });

  it('returns a type without length or with a broken one as is', () => {
    expect(splitType('text')).toEqual({ type: 'text', length: '' });
    expect(splitType('varchar(10')).toEqual({ type: 'varchar(10', length: '' });
  });

  it('is the reverse of composeType', () => {
    for (const full of ['varchar(255)', 'decimal(10,2) unsigned', 'text', "set('x','y')"]) {
      const { type, length } = splitType(full);
      expect(composeType(type, length)).toBe(full);
    }
  });
});

describe('designProblems', () => {
  it('accepts the design every new table starts with, on every driver', () => {
    for (const driver of ['mysql', 'postgres', 'sqlite'] as const) {
      expect(designProblems(newTableDesign(driver, 'orders'), driver)).toEqual([]);
    }
  });

  it('needs a table name and at least one column', () => {
    expect(designProblems(design([], '  '), 'mysql')).toEqual([
      { kind: 'table-name' },
      { kind: 'no-columns' },
    ]);
  });

  it('needs column names and types', () => {
    expect(designProblems(design([column({ id: 'a', name: ' ', type: '' })]), 'postgres')).toEqual([
      { kind: 'column-name', column: 'a' },
      { kind: 'column-type', column: 'a' },
    ]);
  });

  it('finds duplicate names regardless of case and spaces', () => {
    expect(
      designProblems(
        design([column({ id: 'a', name: 'Email' }), column({ id: 'b', name: ' email ' })]),
        'postgres',
      ),
    ).toEqual([{ kind: 'duplicate-column', column: 'b' }]);
  });

  it('wants an integer type for auto numbering', () => {
    const auto = column({ id: 'a', type: 'varchar', autoIncrement: true, primaryKey: true });
    for (const driver of ['mysql', 'postgres', 'sqlite'] as const) {
      expect(designProblems(design([auto]), driver)).toEqual([
        { kind: 'auto-increment', column: 'a', reason: 'type' },
      ]);
    }
    expect(designProblems(design([{ ...auto, type: 'BIGINT  Unsigned' }]), 'mysql')).toEqual([]);
    expect(designProblems(design([{ ...auto, type: 'int8' }]), 'postgres')).toEqual([]);
    // In SQLite only INTEGER PRIMARY KEY numbers itself.
    expect(designProblems(design([{ ...auto, type: 'int' }]), 'sqlite')).toEqual([
      { kind: 'auto-increment', column: 'a', reason: 'type' },
    ]);
  });

  it('wants the auto-numbered column in the key where the database does', () => {
    const auto = column({ id: 'a', type: 'integer', autoIncrement: true });
    expect(designProblems(design([{ ...auto, type: 'int' }]), 'mysql')).toEqual([
      { kind: 'auto-increment', column: 'a', reason: 'key' },
    ]);
    expect(designProblems(design([auto]), 'postgres')).toEqual([]);
    const composite = design([
      { ...auto, primaryKey: true },
      column({ id: 'b', name: 'other', primaryKey: true }),
    ]);
    expect(designProblems(composite, 'sqlite')).toEqual([
      { kind: 'auto-increment', column: 'a', reason: 'key' },
    ]);
  });

  it('allows several identity columns only in PostgreSQL', () => {
    const first = column({
      id: 'a',
      name: 'a',
      type: 'integer',
      autoIncrement: true,
      primaryKey: true,
    });
    const second = { ...first, id: 'b', name: 'b' };
    expect(designProblems(design([first, second]), 'postgres')).toEqual([]);
    expect(designProblems(design([first, { ...second, type: 'int' }]), 'mysql')).toContainEqual({
      kind: 'auto-increment',
      column: 'b',
      reason: 'several',
    });
  });

  it('refuses a default next to an identity in PostgreSQL', () => {
    const auto = column({ id: 'a', type: 'integer', autoIncrement: true, defaultValue: '1' });
    expect(designProblems(design([auto]), 'postgres')).toEqual([
      { kind: 'auto-increment', column: 'a', reason: 'default' },
    ]);
  });
});

describe('newTableDesign', () => {
  it('starts with an auto-numbered integer key named id', () => {
    const mysql = newTableDesign('mysql', 'orders');
    expect(mysql.name).toBe('orders');
    expect(mysql.columns).toEqual([
      expect.objectContaining({ name: 'id', type: 'int', primaryKey: true, autoIncrement: true }),
    ]);
    expect(newTableDesign('sqlite').columns[0]?.type).toBe('integer');
    expect(newTableDesign('postgres').name).toBe('');
  });
});

describe('designProblems: indexes and keys', () => {
  const a = column({ id: 'a', name: 'a' });
  const b = column({ id: 'b', name: 'b' });
  const index = (overrides: Partial<IndexDesign> = {}): IndexDesign => ({
    id: 'i1',
    name: 'ix_a',
    columns: ['a'],
    unique: false,
    ...overrides,
  });
  const key = (overrides: Partial<ForeignKeyDesign> = {}): ForeignKeyDesign => ({
    id: 'k1',
    name: 'fk_a',
    columns: ['a'],
    targetTable: 'parents',
    targetColumns: ['id'],
    onDelete: 'NO ACTION',
    onUpdate: 'NO ACTION',
    ...overrides,
  });
  const withParts = (indexes: IndexDesign[], foreignKeys: ForeignKeyDesign[]): TableDesign => ({
    ...design([a, b]),
    indexes,
    foreignKeys,
  });

  it('accepts well-formed indexes and keys', () => {
    expect(
      designProblems(
        withParts([index(), index({ id: 'i2', name: 'ix_ab', columns: ['a', 'b'] })], [key()]),
        'mysql',
      ),
    ).toEqual([]);
  });

  it('needs index names, unique ones regardless of case', () => {
    expect(
      designProblems(
        withParts(
          [index({ name: ' ' }), index({ id: 'i2', name: 'IX' }), index({ id: 'i3', name: 'ix' })],
          [],
        ),
        'mysql',
      ),
    ).toEqual([
      { kind: 'index-name', index: 'i1' },
      { kind: 'duplicate-index', index: 'i3' },
    ]);
  });

  it('needs columns that exist, each once', () => {
    for (const columns of [[], ['a', 'a'], ['zz']]) {
      expect(designProblems(withParts([index({ columns })], []), 'postgres')).toEqual([
        { kind: 'index-columns', index: 'i1' },
      ]);
    }
  });

  it('checks key names, columns, target and pairing', () => {
    expect(
      designProblems(
        withParts(
          [],
          [
            key({ name: '' }),
            key({ id: 'k2', name: 'FK_A' }),
            key({ id: 'k3', name: 'fk_a', columns: [], targetColumns: [] }),
            key({ id: 'k4', name: 'k4', targetTable: ' ' }),
            key({ id: 'k5', name: 'k5', columns: ['a', 'b'], targetColumns: ['id'] }),
            key({ id: 'k6', name: 'k6', targetColumns: [' '] }),
          ],
        ),
        'sqlite',
      ),
    ).toEqual([
      { kind: 'key-name', key: 'k1' },
      { kind: 'duplicate-key', key: 'k3' },
      { kind: 'key-columns', key: 'k3' },
      { kind: 'key-target', key: 'k4' },
      { kind: 'key-target-columns', key: 'k5' },
      { kind: 'key-target-columns', key: 'k6' },
    ]);
  });
});

describe('columnNames', () => {
  it('maps ids to the current, trimmed names in the given order', () => {
    const d = design([column({ id: 'a', name: ' first ' }), column({ id: 'b', name: 'second' })]);
    expect(columnNames(d, ['b', 'a'])).toEqual(['second', 'first']);
    expect(columnNames(d, ['gone', 'a'])).toEqual(['first']);
  });
});
