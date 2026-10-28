import { beforeEach, describe, expect, it } from 'vitest';
import type { EditableResult } from '../../../src/core/model/editability';
import { linksOf, ResultLinks, tableLabel } from '../../../src/services/result-links';
import { ResultStore } from '../../../src/services/result-store';
import type { CellValue } from '../../../src/shared/cell-value';

const EDIT: EditableResult = {
  editable: true,
  table: { name: 'items' },
  columnMap: ['id', 'order_id', 'tenant', 'product_id'],
  columns: [null, null, null, null],
  keyColumns: ['id'],
  keyIndexes: [0],
  foreignKeys: [
    { name: 'fk_order', columns: ['order_id'], target: { name: 'orders' }, targetColumns: ['id'] },
    {
      name: 'fk_composite',
      columns: ['tenant', 'product_id'],
      target: { schema: 'shop', name: 'products' },
      targetColumns: ['tenant', 'id'],
    },
  ],
};

describe('tableLabel', () => {
  it('joins whatever qualifies the table', () => {
    expect(tableLabel({ name: 't' })).toBe('t');
    expect(tableLabel({ schema: 's', name: 't' })).toBe('s.t');
    expect(tableLabel({ database: 'd', name: 't' })).toBe('d.t');
  });
});

describe('linksOf', () => {
  it('lists the keys whose columns are all in the result, with their positions', () => {
    expect(linksOf(EDIT)).toEqual([
      { id: 0, columns: [1], target: 'orders' },
      { id: 1, columns: [2, 3], target: 'shop.products' },
    ]);
  });

  it("keeps the position in the table's list, even when an earlier key is left out", () => {
    expect(linksOf({ ...EDIT, columnMap: ['id', null, 'tenant', 'product_id'] })).toEqual([
      { id: 1, columns: [2, 3], target: 'shop.products' },
    ]);
  });

  it('leaves out a key with a column the result does not show', () => {
    expect(linksOf({ ...EDIT, columnMap: ['id', 'order_id', 'tenant', null] })).toEqual([
      { id: 0, columns: [1], target: 'orders' },
    ]);
  });

  it('has none for a table without keys', () => {
    const { foreignKeys: _none, ...plain } = EDIT;
    expect(linksOf(plain)).toEqual([]);
  });
});

describe('ResultLinks.follow', () => {
  let results: ResultStore;
  let links: ResultLinks;

  function add(rows: CellValue[][], edit: EditableResult | null = EDIT): string {
    return results.add({
      documentUri: 'file:///q.sql',
      statement: 'SELECT * FROM items',
      statementStart: 0,
      columns: [{ name: 'id' }, { name: 'order_id' }, { name: 'tenant' }, { name: 'product_id' }],
      rows,
      truncated: false,
      durationMs: 1,
      ...(edit === null ? {} : { edit }),
      origin: { target: { connectionId: 'c1', database: 'app' }, owner: 'o' },
    }).id;
  }

  beforeEach(() => {
    results = new ResultStore();
    links = new ResultLinks(results);
  });

  it('filters the target table to the value of the key', () => {
    const id = add([[1, 42, 'a', 7]]);
    expect(links.follow({ resultId: id, row: 0, link: 0 })).toEqual({
      ok: true,
      target: { connectionId: 'c1', database: 'app' },
      table: { name: 'orders' },
      filter: { conditions: [{ column: 'id', operator: 'eq', value: '42' }] },
    });
  });

  it('matches every column of a composite key', () => {
    const id = add([[1, 42, 'acme', 7]]);
    expect(links.follow({ resultId: id, row: 0, link: 1 })).toMatchObject({
      ok: true,
      table: { schema: 'shop', name: 'products' },
      filter: {
        conditions: [
          { column: 'tenant', operator: 'eq', value: 'acme' },
          { column: 'id', operator: 'eq', value: '7' },
        ],
      },
    });
  });

  it('keeps the exact text of a big number', () => {
    const id = add([[1, { kind: 'bigint', text: '9223372036854775807' }, 'a', 7]]);
    const outcome = links.follow({ resultId: id, row: 0, link: 0 });
    expect(outcome.ok && outcome.filter.conditions[0]?.value).toBe('9223372036854775807');
  });

  it('follows the value the grid shows, unsaved edit included', () => {
    const id = add([[1, 42, 'a', 7]], {
      ...EDIT,
      columns: [
        null,
        { name: 'order_id', dataType: 'int', nullable: true, kind: 'integer' },
        null,
        null,
      ],
    });
    results.setChange(id, 0, 1, { kind: 'value', value: 99 });
    const outcome = links.follow({ resultId: id, row: 0, link: 0 });
    expect(outcome.ok && outcome.filter.conditions[0]?.value).toBe('99');
  });

  it('says a NULL key points at nothing, also when only part of a composite key is NULL', () => {
    const id = add([
      [1, null, 'a', 7],
      [2, 5, null, 7],
    ]);
    expect(links.follow({ resultId: id, row: 0, link: 0 })).toEqual({
      ok: false,
      error: 'null-value',
    });
    expect(links.follow({ resultId: id, row: 1, link: 1 })).toEqual({
      ok: false,
      error: 'null-value',
    });
  });

  it('will not follow a binary key', () => {
    const id = add([[1, { kind: 'binary', size: 2, preview: '0102' }, 'a', 7]]);
    expect(links.follow({ resultId: id, row: 0, link: 0 })).toEqual({
      ok: false,
      error: 'unsupported',
    });
  });

  it('refuses an unknown result, link or row, and a result that cannot be edited', () => {
    const id = add([[1, 42, 'a', 7]]);
    expect(links.follow({ resultId: 'nope', row: 0, link: 0 })).toEqual({
      ok: false,
      error: 'no-link',
    });
    expect(links.follow({ resultId: id, row: 0, link: 5 })).toEqual({
      ok: false,
      error: 'no-link',
    });
    expect(links.follow({ resultId: id, row: 9, link: 0 })).toEqual({
      ok: false,
      error: 'no-such-row',
    });
    const plain = add([[1, 42, 'a', 7]], null);
    expect(links.follow({ resultId: plain, row: 0, link: 0 })).toEqual({
      ok: false,
      error: 'no-link',
    });
  });

  it('refuses a result with no known connection', () => {
    const id = results.add({
      documentUri: 'u',
      statement: 's',
      statementStart: 0,
      columns: [{ name: 'order_id' }],
      rows: [[1]],
      truncated: false,
      durationMs: 1,
      edit: { ...EDIT, columnMap: ['order_id'], foreignKeys: [EDIT.foreignKeys?.[0] as never] },
    }).id;
    expect(links.follow({ resultId: id, row: 0, link: 0 })).toEqual({
      ok: false,
      error: 'no-link',
    });
  });
});
