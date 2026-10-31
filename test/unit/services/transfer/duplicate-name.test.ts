import { describe, expect, it } from 'vitest';
import {
  copyName,
  duplicateNameProblem,
  tableNameLimit,
} from '../../../../src/services/transfer/duplicate-name';

describe('tableNameLimit', () => {
  it('knows the servers that cut long names short', () => {
    expect(tableNameLimit('postgres')).toBe(63);
    expect(tableNameLimit('mysql')).toBe(64);
    expect(tableNameLimit('mssql')).toBe(128);
    expect(tableNameLimit('sqlite')).toBe(128);
  });
});

describe('copyName', () => {
  it('suggests name_copy', () => {
    expect(copyName('orders', ['orders', 'customers'], 64)).toBe('orders_copy');
  });

  it('counts on when the copy is taken, in any case', () => {
    expect(copyName('orders', ['orders', 'ORDERS_COPY'], 64)).toBe('orders_copy2');
    expect(copyName('orders', ['orders', 'orders_copy', 'orders_copy2'], 64)).toBe('orders_copy3');
  });

  it('cuts a long name so the suffix still fits', () => {
    const long = 'a'.repeat(70);
    const suggested = copyName(long, [long], 63);
    expect(suggested).toHaveLength(63);
    expect(suggested.endsWith('_copy')).toBe(true);
  });

  it('keeps at least one character of the name', () => {
    expect(copyName('orders', [], 3)).toBe('o_copy');
  });
});

describe('duplicateNameProblem', () => {
  const existing = ['orders', 'Customers'];

  it('accepts a free name', () => {
    expect(duplicateNameProblem('orders_copy', existing, 64)).toBeUndefined();
    expect(duplicateNameProblem('  spaced  ', existing, 64)).toBeUndefined();
  });

  it('wants a name', () => {
    expect(duplicateNameProblem('', existing, 64)).toBe('empty');
    expect(duplicateNameProblem('   ', existing, 64)).toBe('empty');
  });

  it('refuses a name that is too long for the server', () => {
    expect(duplicateNameProblem('x'.repeat(65), existing, 64)).toBe('too-long');
    expect(duplicateNameProblem('x'.repeat(64), existing, 64)).toBeUndefined();
  });

  it('refuses a name a table or view already has, in any case', () => {
    expect(duplicateNameProblem('customers', existing, 64)).toBe('taken');
    expect(duplicateNameProblem(' ORDERS ', existing, 64)).toBe('taken');
  });
});
