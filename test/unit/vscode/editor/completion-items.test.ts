import { describe, expect, it, vi } from 'vitest';
import type { ColumnInfo, ObjectScope, TableRef } from '../../../../src/core/model/objects';
import {
  type CompletionEntry,
  completionEntries,
  type CompletionInput,
} from '../../../../src/vscode/editor/completion-items';

const COLUMNS: Readonly<Record<string, ColumnInfo[]>> = {
  orders: [
    { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
    { name: 'customer_id', dataType: 'int', nullable: false, primaryKey: false },
    { name: 'total', dataType: 'decimal(10,2)', nullable: true, primaryKey: false },
  ],
  customers: [
    { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
    { name: 'email', dataType: 'varchar(255)', nullable: false, primaryKey: false },
  ],
};

function metadata() {
  return {
    listTables: vi.fn((scope: ObjectScope) =>
      Promise.resolve(
        scope.schema === 'archive'
          ? [{ name: 'old_orders', kind: 'table' as const }]
          : scope.schema !== undefined || (scope.database ?? 'shop') !== 'shop'
            ? []
            : [
                { name: 'orders', kind: 'table' as const },
                { name: 'customers', kind: 'table' as const },
                { name: 'order_totals', kind: 'view' as const },
              ],
      ),
    ),
    listColumns: vi.fn((table: TableRef) => Promise.resolve(COLUMNS[table.name] ?? [])),
  };
}

/** Completion where `|` marks the cursor. */
async function at(
  text: string,
  overrides: Partial<CompletionInput> = {},
): Promise<CompletionEntry[]> {
  const offset = text.indexOf('|');
  return await completionEntries({
    sql: text.replace('|', ''),
    offset,
    driver: 'mysql',
    metadata: metadata(),
    scope: { database: 'shop' },
    ...overrides,
  });
}

function labels(entries: readonly CompletionEntry[], kind: CompletionEntry['kind']): string[] {
  return entries.filter((entry) => entry.kind === kind).map((entry) => entry.label);
}

describe('completionEntries', () => {
  it('offers nothing inside a string or a comment', async () => {
    expect(await at("SELECT 'ab|c'")).toEqual([]);
    expect(await at('SELECT 1 -- no|te')).toEqual([]);
  });

  it('offers keywords, functions and snippets where a statement begins', async () => {
    const entries = await at('|');
    expect(labels(entries, 'keyword')).toContain('SELECT');
    expect(labels(entries, 'snippet')).toContain('sel');
    expect(labels(entries, 'function')).toContain('COALESCE');
    expect(labels(entries, 'table')).toEqual(['orders', 'customers']);
    expect(labels(entries, 'view')).toEqual(['order_totals']);
  });

  it('offers snippets only at the start of a statement', async () => {
    expect(labels(await at('SELECT 1; |'), 'snippet')).toContain('ins');
    expect(labels(await at('SELECT 1 |'), 'snippet')).toEqual([]);
  });

  it('turns functions into calls and does not repeat them as keywords', async () => {
    const entries = await at('SELECT |');
    const coalesce = entries.find((entry) => entry.label === 'COALESCE');
    expect(coalesce).toMatchObject({
      kind: 'function',
      insertText: 'COALESCE(${1:value}, ${2:fallback})',
      snippet: true,
      detail: 'COALESCE(value, fallback)',
    });
    expect(entries.filter((entry) => entry.label === 'COUNT')).toHaveLength(1);
    expect(labels(entries, 'function')).toContain('GROUP_CONCAT');
    expect(labels(await at('SELECT |', { driver: 'postgres' }), 'function')).toContain(
      'STRING_AGG',
    );
  });

  it('offers the columns of every joined table, with where they come from', async () => {
    const entries = await at('SELECT | FROM orders o JOIN customers c ON c.id = o.customer_id');
    const columns = entries.filter((entry) => entry.kind === 'column');
    expect(columns.map((c) => [c.label, c.description])).toEqual([
      ['id', 'o'],
      ['customer_id', 'o'],
      ['total', 'o'],
      ['id', 'c'],
      ['email', 'c'],
    ]);
    expect(columns[0]).toMatchObject({ detail: 'int', sortText: '0_id' });
    expect(columns[1]?.sortText).toBe('1_customer_id');
    expect(labels(entries, 'alias')).toEqual(['o', 'c']);
  });

  it('offers the columns of an alias after a dot, whatever its case', async () => {
    const entries = await at('SELECT C.| FROM orders o JOIN customers c ON true');
    expect(labels(entries, 'column')).toEqual(['id', 'email']);
    expect(labels(entries, 'keyword')).toEqual([]);
  });

  it('knows the columns of a CTE and of a FROM subquery', async () => {
    const cte = await at(
      'WITH big AS (SELECT id, total AS amount FROM orders) SELECT big.| FROM big',
    );
    expect(labels(cte, 'column')).toEqual(['id', 'amount']);
    const sub = await at('SELECT s.| FROM (SELECT email FROM customers) s');
    expect(labels(sub, 'column')).toEqual(['email']);
  });

  it('expands a star of a CTE from its source table', async () => {
    const entries = await at('WITH x AS (SELECT * FROM customers) SELECT x.| FROM x');
    expect(labels(entries, 'column')).toEqual(['id', 'email']);
  });

  it('offers CTE names where a table goes', async () => {
    const entries = await at('WITH big AS (SELECT id FROM orders) SELECT * FROM |');
    expect(entries.find((entry) => entry.kind === 'cte')).toMatchObject({
      label: 'big',
      detail: 'id',
    });
    expect(labels(entries, 'table')).toContain('orders');
  });

  it('offers the tables of a schema or database after its name', async () => {
    expect(labels(await at('SELECT * FROM archive.|'), 'table')).toEqual(['old_orders']);
    expect(labels(await at('SELECT * FROM nowhere.|'), 'table')).toEqual([]);
  });

  it('works without a connection: keywords, functions and the statement own tables', async () => {
    const entries = await at('WITH x AS (SELECT a, b FROM t) SELECT x.| FROM x', {
      metadata: undefined,
      driver: undefined,
    });
    expect(labels(entries, 'column')).toEqual(['a', 'b']);
    const fresh = await at('|', { metadata: undefined, driver: undefined });
    expect(labels(fresh, 'table')).toEqual([]);
    expect(labels(fresh, 'keyword').length).toBeGreaterThan(10);
  });

  it('keeps offering what it can when the server fails', async () => {
    const failing = {
      listTables: () => Promise.reject(new Error('gone')),
      listColumns: () => Promise.reject(new Error('gone')),
    };
    const errors: string[] = [];
    const entries = await at('SELECT | FROM orders', {
      metadata: failing,
      onError: (message) => errors.push(message),
    });
    expect(labels(entries, 'keyword')).toContain('FROM');
    expect(labels(entries, 'column')).toEqual([]);
    expect(errors).toEqual(['gone', 'gone']);
  });

  it('does not loop on a recursive CTE that selects from itself', async () => {
    const entries = await at('WITH RECURSIVE n AS (SELECT * FROM n) SELECT n.| FROM n', {
      metadata: undefined,
    });
    expect(labels(entries, 'column')).toEqual([]);
  });

  it('asks for columns in the bound database and in the schema of a mention', async () => {
    const reader = metadata();
    await at('SELECT | FROM sales.orders', { metadata: reader, scope: { database: 'shop' } });
    expect(reader.listColumns).toHaveBeenCalledWith({
      database: 'shop',
      schema: 'sales',
      name: 'orders',
    });
  });
});
