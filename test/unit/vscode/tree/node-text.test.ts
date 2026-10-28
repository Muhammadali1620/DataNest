import { describe, expect, it } from 'vitest';
import {
  describeColumn,
  describeForeignKey,
  describeIndex,
  objectLabel,
} from '../../../../src/vscode/tree/node-text';

describe('describeColumn', () => {
  it('lists the type, the key and the nullability', () => {
    expect(describeColumn({ name: 'id', dataType: 'int', nullable: false, primaryKey: true })).toBe(
      'int, PK, NOT NULL',
    );
  });

  it('shows just the type for a plain nullable column', () => {
    expect(
      describeColumn({ name: 'note', dataType: 'text', nullable: true, primaryKey: false }),
    ).toBe('text');
  });

  it('includes a default when there is one', () => {
    expect(
      describeColumn({
        name: 'created_at',
        dataType: 'datetime',
        nullable: false,
        primaryKey: false,
        defaultValue: 'now()',
      }),
    ).toBe('datetime, NOT NULL, DEFAULT now()');
  });
});

describe('describeIndex', () => {
  it('names the primary key, uniqueness and a special method', () => {
    expect(
      describeIndex({
        name: 'PRIMARY',
        columns: ['id'],
        unique: true,
        primary: true,
        method: 'BTREE',
      }),
    ).toBe('PRIMARY KEY (id)');
    expect(describeIndex({ name: 'u', columns: ['a', 'b'], unique: true, primary: false })).toBe(
      'UNIQUE (a, b)',
    );
    expect(
      describeIndex({
        name: 'f',
        columns: ['body'],
        unique: false,
        primary: false,
        method: 'FULLTEXT',
      }),
    ).toBe('fulltext (body)');
    expect(
      describeIndex({ name: 'g', columns: ['tags'], unique: true, primary: false, method: 'gin' }),
    ).toBe('UNIQUE gin (tags)');
  });

  it('shows the condition of a partial index', () => {
    expect(
      describeIndex({
        name: 'p',
        columns: ['price'],
        unique: false,
        primary: false,
        where: 'price > 10',
      }),
    ).toBe('(price) WHERE price > 10');
  });
});

describe('describeForeignKey', () => {
  it('shows the columns and the qualified target', () => {
    expect(
      describeForeignKey({
        name: 'fk',
        columns: ['a', 'b'],
        target: { schema: 'sales', name: 'orders' },
        targetColumns: ['x', 'y'],
      }),
    ).toBe('(a, b) → sales.orders (x, y)');
  });
});

describe('objectLabel', () => {
  it('adds the arguments of a routine with a signature', () => {
    expect(objectLabel({ kind: 'function', name: 'f', signature: 'a integer' })).toBe(
      'f(a integer)',
    );
    expect(objectLabel({ kind: 'function', name: 'g', signature: '' })).toBe('g()');
    expect(objectLabel({ kind: 'event', name: 'nightly' })).toBe('nightly');
  });
});
