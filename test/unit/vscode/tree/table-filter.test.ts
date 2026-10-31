import { describe, expect, it } from 'vitest';
import {
  MAX_TABLE_FILTER_LENGTH,
  normalizeTableFilter,
  tableFilter,
} from '../../../../src/vscode/tree/table-filter';

const TABLES = ['orders', 'order_items', 'customer_orders', 'customers', 'tmp_orders', 'Products'];

function shown(text: string): string[] {
  const visible = tableFilter(text);
  return TABLES.filter((name) => visible(name));
}

describe('tableFilter', () => {
  it('finds names that contain a plain word, in any case', () => {
    expect(shown('order')).toEqual(['orders', 'order_items', 'customer_orders', 'tmp_orders']);
    expect(shown('PROD')).toEqual(['Products']);
  });

  it('takes several words, any of which may match', () => {
    expect(shown('items, prod')).toEqual(['order_items', 'Products']);
  });

  it('reads wildcards and exclusions as patterns of the whole name', () => {
    expect(shown('order*')).toEqual(['orders', 'order_items']);
    expect(shown('*orders, !tmp_*')).toEqual(['orders', 'customer_orders']);
    expect(shown('customer?')).toEqual(['customers']);
  });

  it('hides with ! alone and shows the rest', () => {
    expect(shown('!*orders*')).toEqual(['order_items', 'customers', 'Products']);
  });

  it('shows everything for an empty or blank text', () => {
    expect(shown('')).toEqual(TABLES);
    expect(shown(' , ')).toEqual(TABLES);
  });

  it('treats regular expression characters as themselves', () => {
    const visible = tableFilter('a.b');
    expect(visible('a.b')).toBe(true);
    expect(visible('axb')).toBe(false);
  });

  it('ignores what is past the length limit', () => {
    const visible = tableFilter(`${'x'.repeat(MAX_TABLE_FILTER_LENGTH)}orders`);
    expect(visible('orders')).toBe(false);
  });
});

describe('normalizeTableFilter', () => {
  it('trims the text and keeps it', () => {
    expect(normalizeTableFilter('  order ')).toBe('order');
  });

  it('is undefined for nothing to filter by', () => {
    for (const text of ['', '   ', ',', ' , \n ']) {
      expect(normalizeTableFilter(text)).toBeUndefined();
    }
  });

  it('cuts a text that is too long', () => {
    expect(normalizeTableFilter('y'.repeat(MAX_TABLE_FILTER_LENGTH + 50))).toHaveLength(
      MAX_TABLE_FILTER_LENGTH,
    );
  });
});
