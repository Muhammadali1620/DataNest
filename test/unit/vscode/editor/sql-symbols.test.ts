import { describe, expect, it } from 'vitest';
import type { ObjectScope } from '../../../../src/core/model/objects';
import type { DriverId } from '../../../../src/shared/connection';
import { definitionTargets, symbolAt } from '../../../../src/vscode/editor/sql-symbols';

/** The symbol where `|` marks the cursor. */
function at(
  text: string,
  driver: DriverId | undefined = 'mysql',
  scope: ObjectScope = { database: 'shop' },
) {
  return symbolAt(text.replace('|', ''), text.indexOf('|'), driver, scope);
}

describe('symbolAt', () => {
  it('names a table by its name or its alias', () => {
    expect(at('SELECT * FROM ord|ers o')?.symbol).toEqual({
      kind: 'table',
      table: { database: 'shop', name: 'orders' },
    });
    expect(at('SELECT o|.id FROM orders o')?.symbol).toEqual({
      kind: 'table',
      table: { database: 'shop', name: 'orders' },
    });
  });

  it('gives the word range for the hover', () => {
    expect(at('SELECT * FROM or|ders')).toMatchObject({ start: 14, end: 20 });
  });

  it('names a column of the table its qualifier points at', () => {
    expect(at('SELECT o.to|tal FROM sales.orders o', 'postgres', {})?.symbol).toEqual({
      kind: 'column',
      table: { schema: 'sales', name: 'orders' },
      column: 'total',
    });
    expect(at('SELECT ORDERS.id| FROM orders')?.symbol).toMatchObject({
      kind: 'column',
      column: 'id',
    });
  });

  it('leaves an unqualified column to every table of the statement', () => {
    expect(at('SELECT em|ail FROM orders o JOIN customers c ON true')?.symbol).toEqual({
      kind: 'loose-column',
      tables: [
        { database: 'shop', name: 'orders' },
        { database: 'shop', name: 'customers' },
      ],
      column: 'email',
    });
  });

  it('reads schema.table and database.table written out', () => {
    expect(at('SELECT * FROM archive.old_or|ders', 'postgres', {})?.symbol).toEqual({
      kind: 'table',
      table: { schema: 'archive', name: 'old_orders' },
    });
    expect(at('SELECT 1 FROM x WHERE crm.peo|ple = 1')?.symbol).toEqual({
      kind: 'table',
      table: { database: 'crm', name: 'people' },
    });
  });

  it('knows CTEs and their columns', () => {
    const text = 'WITH big AS (SELECT id FROM orders) SELECT b|ig.id FROM big';
    expect(at(text)?.symbol).toMatchObject({
      kind: 'cte',
      derived: { name: 'big', columns: ['id'] },
    });
    expect(at('WITH big AS (SELECT id FROM orders) SELECT big.i|d FROM big')?.symbol).toMatchObject(
      {
        kind: 'cte',
      },
    );
  });

  it('names a user routine being called, not built-ins or keywords', () => {
    expect(at('SELECT order_to|tal(1)')?.symbol).toEqual({
      kind: 'routine',
      name: 'order_total',
      scope: { database: 'shop' },
    });
    expect(at('CALL sales.rest|ock(1, 2)', 'postgres', {})?.symbol).toEqual({
      kind: 'routine',
      name: 'restock',
      scope: { schema: 'sales' },
    });
    expect(at('SELECT COUN|T(*) FROM t')).toBeUndefined();
    expect(at('SELECT * FROM t WHERE a I|N (1)')).toBeUndefined();
  });

  it('says nothing about keywords, strings, comments and punctuation', () => {
    expect(at('SEL|ECT 1')).toBeUndefined();
    expect(at("SELECT 'ord|ers'")).toBeUndefined();
    expect(at('SELECT 1 -- ord|ers')).toBeUndefined();
    expect(at('SELECT 1 |+ 2')).toBeUndefined();
  });

  it('takes a quoted name, even one that spells a keyword', () => {
    expect(at('SELECT * FROM "Sel|ect"', 'postgres', {})?.symbol).toEqual({
      kind: 'table',
      table: { name: 'Select' },
    });
  });

  it('treats an unknown word outside any statement table as a table name', () => {
    expect(at('ord|ers')?.symbol).toEqual({
      kind: 'table',
      table: { database: 'shop', name: 'orders' },
    });
  });
});

describe('symbolAt on Oracle (V6.4)', () => {
  it('reads x.name as schema.table, and x.routine( as a routine of schema x', () => {
    expect(at('SELECT * FROM datanest.ord|ers', 'oracle', {})?.symbol).toEqual({
      kind: 'table',
      table: { schema: 'datanest', name: 'orders' },
    });
    expect(at('SELECT datanest.order_to|tal(1) FROM dual', 'oracle', {})?.symbol).toEqual({
      kind: 'routine',
      name: 'order_total',
      scope: { schema: 'datanest' },
    });
  });

  it('takes Oracle built-ins and keywords for no object', () => {
    expect(at('SELECT NV|L(a, 1) FROM dual', 'oracle', {})).toBeUndefined();
    expect(at('SELECT SYS|DATE FROM dual', 'oracle', {})).toBeUndefined();
  });
});

describe('definitionTargets', () => {
  it('tries a table, then a view, with the cursor on the name or the column', () => {
    expect(definitionTargets({ kind: 'table', table: { name: 't' } })).toEqual({
      objects: [
        { kind: 'table', name: 't' },
        { kind: 'view', name: 't' },
      ],
      focus: 't',
    });
    expect(
      definitionTargets({ kind: 'column', table: { schema: 's', name: 't' }, column: 'c' })?.focus,
    ).toBe('c');
  });

  it('tries a function, then a procedure', () => {
    expect(
      definitionTargets({ kind: 'routine', name: 'f', scope: { database: 'shop' } })?.objects.map(
        (o) => o.kind,
      ),
    ).toEqual(['function', 'procedure']);
  });

  it('has nowhere to go for CTEs and columns of an unknown table', () => {
    expect(
      definitionTargets({ kind: 'cte', derived: { name: 'x', columns: [], starFrom: [] } }),
    ).toBeUndefined();
    expect(definitionTargets({ kind: 'loose-column', tables: [], column: 'c' })).toBeUndefined();
  });
});
