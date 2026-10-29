import { describe, expect, it } from 'vitest';
import { callSnippet, functionsOf } from '../../../../src/core/sql/functions';
import { snippetsOf } from '../../../../src/core/sql/snippets';
import { splitStatements } from '../../../../src/core/sql/split';

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

describe('SQL Server functions and snippets (V6.2)', () => {
  it('offers LEN and SUBSTRING instead of LENGTH and SUBSTR', () => {
    const names = functionsOf('mssql').map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(['LEN', 'SUBSTRING', 'GETDATE', 'ISNULL', 'IIF']));
    expect(names).not.toContain('LENGTH');
    expect(names).not.toContain('SUBSTR');
    for (const driver of ['mysql', 'postgres', 'sqlite'] as const) {
      expect(
        functionsOf(driver).map((f) => f.name),
        driver,
      ).toContain('LENGTH');
    }
    expect(functionsOf().map((f) => f.name)).not.toContain('LENGTH');
  });

  it('names each function once per dialect', () => {
    const names = functionsOf('mssql').map((f) => f.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('offers MERGE, TOP and a procedure skeleton with GO', () => {
    const snippets = snippetsOf('mssql');
    expect(snippets.find((s) => s.prefix === 'upsert')?.body).toMatch(/^MERGE INTO/u);
    expect(snippets.find((s) => s.prefix === 'top')?.body).toContain('TOP (${1:100})');
    expect(snippets.find((s) => s.prefix === 'proc')?.body).toMatch(/\nGO$/u);
  });
});

describe('ClickHouse completion (V6.3)', () => {
  it('offers its own functions next to the common ones', () => {
    const names = functionsOf('clickhouse').map((fn) => fn.name);
    expect(names).toEqual(
      expect.arrayContaining(['COUNT', 'now', 'toDateTime', 'uniqExact', 'groupArray', 'LENGTH']),
    );
    expect(new Set(names).size).toBe(names.length);
  });

  it('offers a MergeTree table and a FINAL select', () => {
    const snippets = snippetsOf('clickhouse');
    const table = snippets.find((snippet) => snippet.prefix === 'table');
    expect(table?.body).toContain('ENGINE = MergeTree');
    expect(table?.body).toContain('ORDER BY');
    expect(snippets.find((snippet) => snippet.prefix === 'final')?.body).toContain('FINAL');
    expect(snippets.find((snippet) => snippet.prefix === 'sel')).toBeDefined();
  });
});

describe('Oracle completion (V6.4)', () => {
  /** A snippet body as it reads once every placeholder holds its default text. */
  const filled = (body: string): string => body.replace(/\$\{\d+:([^}]*)\}/gu, '$1');

  it('offers its own functions next to LENGTH and SUBSTR, each once', () => {
    const names = functionsOf('oracle').map((fn) => fn.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'COUNT',
        'LENGTH',
        'SUBSTR',
        'SYSDATE',
        'SYSTIMESTAMP',
        'NVL',
        'NVL2',
        'DECODE',
        'TO_CHAR',
        'TO_DATE',
        'LISTAGG',
        'SYS_GUID',
      ]),
    );
    expect(new Set(names).size).toBe(names.length);
    expect(functionsOf('mysql').map((fn) => fn.name)).not.toContain('NVL2');
  });

  it('writes calls with their arguments as placeholders', () => {
    const nvl = functionsOf('oracle').find((fn) => fn.name === 'NVL');
    expect(nvl === undefined ? '' : callSnippet(nvl)).toBe('NVL(${1:value}, ${2:fallback})');
    const sysGuid = functionsOf('oracle').find((fn) => fn.name === 'SYS_GUID');
    expect(sysGuid === undefined ? '' : callSnippet(sysGuid)).toBe('SYS_GUID()');
  });

  it('offers FETCH FIRST instead of LIMIT, and blocks that end with a `/` line', () => {
    const snippets = snippetsOf('oracle');
    const top = snippets.find((snippet) => snippet.prefix === 'top')?.body ?? '';
    expect(top).toContain('FETCH FIRST ${4:100} ROWS ONLY');
    expect(top).not.toContain('LIMIT');
    for (const prefix of ['proc', 'block']) {
      const body = snippets.find((snippet) => snippet.prefix === prefix)?.body ?? '';
      expect(body, prefix).toMatch(/END;\n\/$/u);
      // The `/` line ends the block, which runs as one statement with its semicolons.
      const statements = splitStatements(filled(body), 'oracle');
      expect(statements, prefix).toHaveLength(1);
      expect(statements[0]?.text, prefix).toMatch(/END;$/u);
    }
    expect(snippets.find((snippet) => snippet.prefix === 'sel')).toBeDefined();
  });
});
