import { describe, expect, it } from 'vitest';
import {
  DEFAULT_VIEW,
  gutterWidth,
  headerHeight,
  isTicked,
  loadView,
  NO_TICKS,
  normalizeView,
  saveView,
  tickedCount,
  tickedRows,
  toggleAllTicks,
  toggleTick,
  VIEW_STORAGE_KEY,
} from '../../../../../webview/src/apps/result-grid/grid-view';

describe('normalizeView', () => {
  it('keeps a valid view as it is', () => {
    const view = {
      layout: 'json',
      rowHeight: 40,
      fontSize: 16,
      lines: 'columns',
      align: 'center',
      rowNumbers: false,
      checkboxes: false,
      font: 'mono',
      showTime: false,
      draggableColumns: true,
    };
    expect(normalizeView(view)).toEqual(view);
  });

  it('falls back field by field for anything unknown or wrong', () => {
    expect(
      normalizeView({
        layout: 'cards',
        rowHeight: 'tall',
        fontSize: '14',
        lines: 'dots',
        align: 1,
        rowNumbers: 'yes',
        font: 'serif',
        showTime: 1,
        draggableColumns: 'yes',
      }),
    ).toEqual(DEFAULT_VIEW);
  });

  it('clamps and rounds a row height instead of refusing it', () => {
    expect(normalizeView({ rowHeight: 7 }).rowHeight).toBe(20);
    expect(normalizeView({ rowHeight: 500 }).rowHeight).toBe(64);
    expect(normalizeView({ rowHeight: 33.4 }).rowHeight).toBe(33);
    expect(normalizeView({ rowHeight: Number.NaN }).rowHeight).toBe(32);
  });

  it.each([null, undefined, 5, 'text', []])('gives the defaults for %s', (raw) => {
    expect(normalizeView(raw)).toEqual(DEFAULT_VIEW);
  });
});

describe('geometry', () => {
  it('makes the header a little over two text lines', () => {
    expect(headerHeight(DEFAULT_VIEW)).toBe(46);
    expect(headerHeight({ ...DEFAULT_VIEW, fontSize: 12 })).toBe(40);
  });

  it('sizes the gutter by what it holds and by the digits of the row count', () => {
    const both = gutterWidth(DEFAULT_VIEW, 3);
    expect(gutterWidth(DEFAULT_VIEW, 6)).toBeGreaterThan(both);
    expect(gutterWidth({ ...DEFAULT_VIEW, checkboxes: false }, 3)).toBeLessThan(both);
    expect(gutterWidth({ ...DEFAULT_VIEW, rowNumbers: false }, 3)).toBeLessThan(both);
    expect(gutterWidth({ ...DEFAULT_VIEW, rowNumbers: false, checkboxes: false }, 3)).toBe(34);
  });

  it('never makes the number column narrower than two digits', () => {
    expect(gutterWidth(DEFAULT_VIEW, 0)).toBe(gutterWidth(DEFAULT_VIEW, 2));
  });
});

describe('storage', () => {
  it('saves and loads a view', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
    saveView(storage, { ...DEFAULT_VIEW, fontSize: 16 });
    expect(data.has(VIEW_STORAGE_KEY)).toBe(true);
    expect(loadView(storage).fontSize).toBe(16);
  });

  it('uses the defaults for nothing, for garbage and for blocked storage', () => {
    expect(loadView(undefined)).toEqual(DEFAULT_VIEW);
    expect(loadView({ getItem: () => null })).toEqual(DEFAULT_VIEW);
    expect(loadView({ getItem: () => '{broken' })).toEqual(DEFAULT_VIEW);
    expect(
      loadView({
        getItem: () => {
          throw new Error('blocked');
        },
      }),
    ).toEqual(DEFAULT_VIEW);
    expect(() => {
      saveView(
        {
          setItem: () => {
            throw new Error('blocked');
          },
        },
        DEFAULT_VIEW,
      );
    }).not.toThrow();
    expect(() => {
      saveView(undefined, DEFAULT_VIEW);
    }).not.toThrow();
  });
});

describe('ticks', () => {
  it('ticks and unticks single rows', () => {
    const one = toggleTick(NO_TICKS, 3);
    expect(isTicked(one, 3)).toBe(true);
    expect(isTicked(one, 2)).toBe(false);
    expect(isTicked(toggleTick(one, 3), 3)).toBe(false);
    expect(tickedRows(one, 10)).toEqual([3]);
  });

  it('keeps rows sorted and ignores ones outside the result', () => {
    const ticks = toggleTick(toggleTick(toggleTick(NO_TICKS, 7), 1), 99);
    expect(tickedRows(ticks, 10)).toEqual([1, 7]);
    expect(tickedCount(ticks, 10)).toBe(2);
  });

  it('ticks every row with the header box, with exceptions', () => {
    const all = toggleAllTicks(NO_TICKS, 5);
    expect(tickedRows(all, 5)).toEqual([0, 1, 2, 3, 4]);
    const without = toggleTick(all, 2);
    expect(tickedRows(without, 5)).toEqual([0, 1, 3, 4]);
    expect(tickedCount(without, 5)).toBe(4);
    expect(isTicked(without, 2)).toBe(false);
  });

  it('clears everything when everything is ticked, and ticks all otherwise', () => {
    const all = toggleAllTicks(NO_TICKS, 4);
    expect(tickedCount(toggleAllTicks(all, 4), 4)).toBe(0);
    const some = toggleTick(NO_TICKS, 1);
    expect(tickedCount(toggleAllTicks(some, 4), 4)).toBe(4);
  });

  it('does not tick anything in an empty result', () => {
    expect(tickedCount(toggleAllTicks(NO_TICKS, 0), 0)).toBe(0);
    expect(tickedRows(toggleAllTicks(NO_TICKS, 0), 0)).toEqual([]);
  });
});

describe('default look', () => {
  it('aligns text to the left and draws a full grid', () => {
    expect(DEFAULT_VIEW.align).toBe('left');
    expect(DEFAULT_VIEW.lines).toBe('all');
  });

  it('uses the new defaults for a stored view that never set them', () => {
    const stored = normalizeView({ rowHeight: 40, fontSize: 15 });
    expect(stored.align).toBe('left');
    expect(stored.lines).toBe('all');
    expect(stored.rowHeight).toBe(40);
  });

  it('keeps what the user chose before', () => {
    const stored = normalizeView({ align: 'center', lines: 'rows' });
    expect(stored.align).toBe('center');
    expect(stored.lines).toBe('rows');
    expect(normalizeView({ align: 'auto' }).align).toBe('auto');
  });
});
