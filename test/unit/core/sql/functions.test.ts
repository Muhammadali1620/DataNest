import { describe, expect, it } from 'vitest';
import { callSnippet, functionsOf } from '../../../../src/core/sql/functions';
import { snippetsOf } from '../../../../src/core/sql/snippets';

describe('functionsOf', () => {
  it('offers the common functions everywhere and dialect ones on top', () => {
    const plain = functionsOf().map((f) => f.name);
    expect(plain).toContain('COALESCE');
    expect(plain).not.toContain('GROUP_CONCAT');
    expect(functionsOf('mysql').map((f) => f.name)).toContain('GROUP_CONCAT');
    expect(functionsOf('postgres').map((f) => f.name)).toContain('STRING_AGG');
    expect(functionsOf('sqlite').map((f) => f.name)).toContain('STRFTIME');
  });

  it('lists each function once per dialect', () => {
    for (const driver of [undefined, 'mysql', 'postgres', 'sqlite'] as const) {
      const names = functionsOf(driver).map((f) => f.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });
});

describe('callSnippet', () => {
  it('puts tab stops on the arguments', () => {
    expect(callSnippet({ name: 'COALESCE', args: ['value', 'fallback'] })).toBe(
      'COALESCE(${1:value}, ${2:fallback})',
    );
    expect(callSnippet({ name: 'NOW', args: [] })).toBe('NOW()');
  });
});

describe('snippetsOf', () => {
  it('has the everyday statements and an upsert per dialect', () => {
    expect(snippetsOf().map((s) => s.prefix)).toEqual([
      'sel',
      'selc',
      'join',
      'ins',
      'upd',
      'del',
      'cte',
      'case',
    ]);
    expect(snippetsOf('mysql').at(-1)?.body).toContain('ON DUPLICATE KEY UPDATE');
    expect(snippetsOf('postgres').at(-1)?.body).toContain('EXCLUDED');
  });

  it('numbers tab stops from 1 and repeats a stop only for the same placeholder', () => {
    for (const snippet of snippetsOf('postgres')) {
      const stops = [...snippet.body.matchAll(/\$\{(\d+):([^}]*)\}/g)];
      const byNumber = new Map<string, string>();
      for (const [, number, placeholder] of stops) {
        const known = byNumber.get(number ?? '');
        expect(known === undefined || known === placeholder, snippet.prefix).toBe(true);
        byNumber.set(number ?? '', placeholder ?? '');
      }
      expect(byNumber.has('1')).toBe(true);
    }
  });
});
