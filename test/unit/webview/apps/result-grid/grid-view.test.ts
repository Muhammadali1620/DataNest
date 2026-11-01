import { describe, expect, it } from 'vitest';
import {
  defaultView,
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
      maxColumnWidth: 640,
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
    // Dragging columns is on unless the user turned it off (V13.5).
    expect(DEFAULT_VIEW.draggableColumns).toBe(true);
    expect(normalizeView({ draggableColumns: false }).draggableColumns).toBe(false);
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

describe('widest column (V13.3)', () => {
  it('is 420 px unless somebody chose otherwise', () => {
    expect(DEFAULT_VIEW.maxColumnWidth).toBe(420);
    expect(normalizeView({}).maxColumnWidth).toBe(420);
  });

  it('keeps a stored limit inside the allowed range', () => {
    expect(normalizeView({ maxColumnWidth: 640 }).maxColumnWidth).toBe(640);
    expect(normalizeView({ maxColumnWidth: 10 }).maxColumnWidth).toBe(120);
    expect(normalizeView({ maxColumnWidth: 99_999 }).maxColumnWidth).toBe(1600);
    expect(normalizeView({ maxColumnWidth: 300.6 }).maxColumnWidth).toBe(301);
  });

  it('falls back to the settings, not to 420, for a wrong stored value', () => {
    const look = { rowHeight: 24, maxColumnWidth: 300 };
    expect(normalizeView({ maxColumnWidth: 'wide' }).maxColumnWidth).toBe(420);
    expect(normalizeView({}, look).maxColumnWidth).toBe(300);
  });
});

describe('the look the settings ask for', () => {
  const look = { rowHeight: 24, maxColumnWidth: 640 };

  function store(initial?: string) {
    const data = new Map<string, string>();
    if (initial !== undefined) {
      data.set(VIEW_STORAGE_KEY, initial);
    }
    return {
      data,
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        data.set(key, value);
      },
    };
  }

  it('builds the untouched view on top of the look', () => {
    expect(defaultView(look)).toEqual({ ...DEFAULT_VIEW, rowHeight: 24, maxColumnWidth: 640 });
    expect(defaultView()).toEqual(DEFAULT_VIEW);
  });

  it('gives a nothing-stored view the look', () => {
    expect(loadView(store(), look)).toEqual(defaultView(look));
    expect(loadView(undefined, look)).toEqual(defaultView(look));
    expect(loadView(store('{broken'), look)).toEqual(defaultView(look));
  });

  it('lets what the user stored win over the look', () => {
    const storage = store(JSON.stringify({ rowHeight: 40, maxColumnWidth: 240 }));
    expect(loadView(storage, look)).toMatchObject({ rowHeight: 40, maxColumnWidth: 240 });
  });

  it('fills only the field the user never set', () => {
    const storage = store(JSON.stringify({ rowHeight: 40 }));
    expect(loadView(storage, look)).toMatchObject({ rowHeight: 40, maxColumnWidth: 640 });
  });

  it('does not write a height or limit equal to the look: that is not a choice', () => {
    const storage = store();
    saveView(storage, { ...defaultView(look), fontSize: 16 }, look);
    const written = JSON.parse(storage.data.get(VIEW_STORAGE_KEY) ?? '{}') as Record<
      string,
      unknown
    >;
    expect(written).not.toHaveProperty('rowHeight');
    expect(written).not.toHaveProperty('maxColumnWidth');
    expect(written).toMatchObject({ fontSize: 16 });
    // So a later change of the setting reaches this viewer.
    expect(loadView(storage, { rowHeight: 40, maxColumnWidth: 900 })).toMatchObject({
      rowHeight: 40,
      maxColumnWidth: 900,
      fontSize: 16,
    });
  });

  it('writes a height or limit that differs from the look', () => {
    const storage = store();
    saveView(storage, { ...defaultView(look), rowHeight: 32, maxColumnWidth: 900 }, look);
    expect(JSON.parse(storage.data.get(VIEW_STORAGE_KEY) ?? '{}')).toMatchObject({
      rowHeight: 32,
      maxColumnWidth: 900,
    });
  });

  it('survives a storage that refuses to write', () => {
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
  });
});
