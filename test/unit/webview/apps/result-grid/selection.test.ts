import { describe, expect, it } from 'vitest';
import {
  extendTo,
  isFocused,
  isNavigationKey,
  isSelected,
  navigate,
  selectAll,
  selectCell,
  selectionBox,
  selectionSize,
  type Selection,
} from '../../../../../webview/src/apps/result-grid/selection';

const bounds = { rowCount: 10, columnCount: 4 };

function at(row: number, column: number): Selection {
  return { anchor: { row, column }, focus: { row, column } };
}

describe('selectCell', () => {
  it('selects one cell', () => {
    expect(selectCell({ row: 2, column: 1 }, bounds)).toEqual(at(2, 1));
  });

  it('keeps the cell inside the grid', () => {
    expect(selectCell({ row: 100, column: 100 }, bounds)).toEqual(at(9, 3));
    expect(selectCell({ row: -5, column: -5 }, bounds)).toEqual(at(0, 0));
  });

  it('has nothing to select in an empty result', () => {
    expect(selectCell({ row: 0, column: 0 }, { rowCount: 0, columnCount: 4 })).toBeUndefined();
    expect(selectCell({ row: 0, column: 0 }, { rowCount: 10, columnCount: 0 })).toBeUndefined();
  });
});

describe('selectionBox', () => {
  it('normalizes a selection made in any direction', () => {
    const upLeft: Selection = { anchor: { row: 5, column: 3 }, focus: { row: 2, column: 1 } };
    expect(selectionBox(upLeft)).toEqual({ top: 2, left: 1, bottom: 5, right: 3 });
    const downRight: Selection = { anchor: { row: 2, column: 1 }, focus: { row: 5, column: 3 } };
    expect(selectionBox(downRight)).toEqual(selectionBox(upLeft));
  });

  it('is a single cell when both ends match', () => {
    expect(selectionBox(at(1, 1))).toEqual({ top: 1, left: 1, bottom: 1, right: 1 });
  });
});

describe('isSelected and isFocused', () => {
  const selection: Selection = { anchor: { row: 1, column: 1 }, focus: { row: 3, column: 2 } };

  it('covers every cell of the rectangle', () => {
    for (const row of [1, 2, 3]) {
      for (const column of [1, 2]) {
        expect(isSelected(selection, row, column)).toBe(true);
      }
    }
  });

  it('excludes cells outside it', () => {
    expect(isSelected(selection, 0, 1)).toBe(false);
    expect(isSelected(selection, 4, 1)).toBe(false);
    expect(isSelected(selection, 2, 0)).toBe(false);
    expect(isSelected(selection, 2, 3)).toBe(false);
  });

  it('is false without a selection', () => {
    expect(isSelected(undefined, 0, 0)).toBe(false);
    expect(isFocused(undefined, 0, 0)).toBe(false);
  });

  it('marks exactly one focused cell', () => {
    expect(isFocused(selection, 3, 2)).toBe(true);
    expect(isFocused(selection, 1, 1)).toBe(false);
  });
});

describe('selectionSize', () => {
  it('counts the cells of the rectangle', () => {
    expect(selectionSize(at(0, 0))).toBe(1);
    expect(selectionSize({ anchor: { row: 0, column: 0 }, focus: { row: 2, column: 1 } })).toBe(6);
  });
});

describe('extendTo', () => {
  it('keeps the anchor and moves the focus', () => {
    const extended = extendTo(at(1, 1), { row: 4, column: 3 }, bounds);
    expect(extended).toEqual({ anchor: { row: 1, column: 1 }, focus: { row: 4, column: 3 } });
  });

  it('clamps the new focus', () => {
    expect(extendTo(at(1, 1), { row: 99, column: 99 }, bounds)?.focus).toEqual({
      row: 9,
      column: 3,
    });
  });

  it('starts a selection when there is none', () => {
    expect(extendTo(undefined, { row: 2, column: 2 }, bounds)).toEqual(at(2, 2));
  });
});

describe('selectAll', () => {
  it('covers the whole grid', () => {
    expect(selectAll(bounds)).toEqual({
      anchor: { row: 0, column: 0 },
      focus: { row: 9, column: 3 },
    });
  });

  it('has nothing to select in an empty result', () => {
    expect(selectAll({ rowCount: 0, columnCount: 0 })).toBeUndefined();
  });
});

describe('navigate', () => {
  it('moves one cell per arrow', () => {
    expect(navigate(at(5, 2), 'ArrowUp', bounds)).toEqual(at(4, 2));
    expect(navigate(at(5, 2), 'ArrowDown', bounds)).toEqual(at(6, 2));
    expect(navigate(at(5, 2), 'ArrowLeft', bounds)).toEqual(at(5, 1));
    expect(navigate(at(5, 2), 'ArrowRight', bounds)).toEqual(at(5, 3));
  });

  it('stays put at the edges', () => {
    expect(navigate(at(0, 0), 'ArrowUp', bounds)).toEqual(at(0, 0));
    expect(navigate(at(0, 0), 'ArrowLeft', bounds)).toEqual(at(0, 0));
    expect(navigate(at(9, 3), 'ArrowDown', bounds)).toEqual(at(9, 3));
    expect(navigate(at(9, 3), 'ArrowRight', bounds)).toEqual(at(9, 3));
  });

  it('extends the selection with shift instead of moving it', () => {
    const extended = navigate(at(2, 1), 'ArrowDown', bounds, { extend: true });
    expect(extended).toEqual({ anchor: { row: 2, column: 1 }, focus: { row: 3, column: 1 } });
  });

  it('shrinks an extended selection when shift goes back', () => {
    const grown: Selection = { anchor: { row: 2, column: 1 }, focus: { row: 5, column: 1 } };
    expect(navigate(grown, 'ArrowUp', bounds, { extend: true })?.focus).toEqual({
      row: 4,
      column: 1,
    });
  });

  it('jumps to the edge with the modifier', () => {
    expect(navigate(at(5, 2), 'ArrowUp', bounds, { jump: true })).toEqual(at(0, 2));
    expect(navigate(at(5, 2), 'ArrowDown', bounds, { jump: true })).toEqual(at(9, 2));
    expect(navigate(at(5, 2), 'ArrowLeft', bounds, { jump: true })).toEqual(at(5, 0));
    expect(navigate(at(5, 2), 'ArrowRight', bounds, { jump: true })).toEqual(at(5, 3));
  });

  it('Home and End work on the row, or the whole grid with the modifier', () => {
    expect(navigate(at(5, 2), 'Home', bounds)).toEqual(at(5, 0));
    expect(navigate(at(5, 2), 'End', bounds)).toEqual(at(5, 3));
    expect(navigate(at(5, 2), 'Home', bounds, { jump: true })).toEqual(at(0, 0));
    expect(navigate(at(5, 2), 'End', bounds, { jump: true })).toEqual(at(9, 3));
  });

  it('pages by the viewport height', () => {
    const big = { rowCount: 1000, columnCount: 2 };
    expect(navigate(at(100, 0), 'PageDown', big, { pageRows: 25 })).toEqual(at(125, 0));
    expect(navigate(at(100, 0), 'PageUp', big, { pageRows: 25 })).toEqual(at(75, 0));
  });

  it('pages at least one row even with a silly page size', () => {
    expect(navigate(at(5, 0), 'PageDown', bounds, { pageRows: 0 })).toEqual(at(6, 0));
  });

  it('clamps a page that would leave the grid', () => {
    expect(navigate(at(1, 0), 'PageUp', bounds, { pageRows: 50 })).toEqual(at(0, 0));
    expect(navigate(at(8, 0), 'PageDown', bounds, { pageRows: 50 })).toEqual(at(9, 0));
  });

  it('starts at the first cell when nothing is selected yet', () => {
    expect(navigate(undefined, 'ArrowDown', bounds)).toEqual(at(0, 0));
  });

  it('has nothing to move in an empty result', () => {
    expect(navigate(at(0, 0), 'ArrowDown', { rowCount: 0, columnCount: 0 })).toBeUndefined();
  });
});

describe('isNavigationKey', () => {
  it('accepts the keys the grid handles', () => {
    for (const key of [
      'ArrowUp',
      'ArrowDown',
      'ArrowLeft',
      'ArrowRight',
      'Home',
      'End',
      'PageUp',
      'PageDown',
    ]) {
      expect(isNavigationKey(key)).toBe(true);
    }
  });

  it('leaves other keys to the host', () => {
    for (const key of ['a', 'Enter', 'Escape', 'Tab', 'F5', ' ']) {
      expect(isNavigationKey(key)).toBe(false);
    }
  });
});
