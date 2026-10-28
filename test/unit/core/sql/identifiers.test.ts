import { describe, expect, it } from 'vitest';
import { identifierLimit, identifierProblem } from '../../../../src/core/sql/identifiers';

describe('identifierProblem', () => {
  it('accepts ordinary names, unicode and names that need quoting', () => {
    for (const name of ['orders', 'Заказы', 'order items', 'a"b', 'x`y', '日本']) {
      for (const driver of ['mysql', 'postgres', 'sqlite'] as const) {
        expect(identifierProblem(name, driver)).toBeUndefined();
      }
    }
  });

  it('rejects empty and blank names', () => {
    expect(identifierProblem('', 'mysql')).toBe('empty');
    expect(identifierProblem('   ', 'postgres')).toBe('empty');
  });

  it('rejects a NUL character, which no server can store in a name', () => {
    expect(identifierProblem('a\u0000b', 'sqlite')).toBe('nul');
  });

  it('counts characters in MySQL, up to 64', () => {
    expect(identifierProblem('я'.repeat(64), 'mysql')).toBeUndefined();
    expect(identifierProblem('a'.repeat(65), 'mysql')).toBe('too-long');
  });

  it('counts bytes in PostgreSQL, which silently cuts longer names', () => {
    expect(identifierProblem('a'.repeat(63), 'postgres')).toBeUndefined();
    expect(identifierProblem('a'.repeat(64), 'postgres')).toBe('too-long');
    // 32 Cyrillic letters are 64 bytes in UTF-8.
    expect(identifierProblem('я'.repeat(32), 'postgres')).toBe('too-long');
  });

  it('has no length limit in SQLite', () => {
    expect(identifierProblem('a'.repeat(1000), 'sqlite')).toBeUndefined();
  });
});

describe('identifierLimit', () => {
  it('names the limit for the message', () => {
    expect(identifierLimit('mysql')).toBe(64);
    expect(identifierLimit('postgres')).toBe(63);
    expect(identifierLimit('sqlite')).toBeUndefined();
  });
});
