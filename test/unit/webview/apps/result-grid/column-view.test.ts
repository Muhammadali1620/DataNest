import { describe, expect, it } from 'vitest';
import {
  type ColumnView,
  displayOrder,
  isCustomized,
  isHidden,
  isPinned,
  NO_VIEW,
  showAll,
  toggleHidden,
  togglePinned,
  viewKey,
} from '../../../../../webview/src/apps/result-grid/column-view';

const view = (hidden: number[], pinned: number[]): ColumnView => ({ hidden, pinned });

describe('displayOrder', () => {
  it('is every column in order for a plain view', () => {
    expect(displayOrder(4, NO_VIEW)).toEqual({ order: [0, 1, 2, 3], pinnedCount: 0 });
  });

  it('leaves hidden columns out', () => {
    expect(displayOrder(4, view([1, 3], [])).order).toEqual([0, 2]);
  });

  it('puts pinned columns first, in the order they were pinned', () => {
    expect(displayOrder(5, view([], [3, 1]))).toEqual({ order: [3, 1, 0, 2, 4], pinnedCount: 2 });
  });

  it('does not show a pinned column that is hidden', () => {
    expect(displayOrder(4, view([1], [1, 2]))).toEqual({ order: [2, 0, 3], pinnedCount: 1 });
  });

  it('ignores indexes that are not columns, and repeats', () => {
    expect(displayOrder(3, view([9, -1], [5, 1, 1, 1.5])).order).toEqual([1, 0, 2]);
  });

  it('has nothing for no columns', () => {
    expect(displayOrder(0, NO_VIEW)).toEqual({ order: [], pinnedCount: 0 });
    expect(displayOrder(-2, NO_VIEW)).toEqual({ order: [], pinnedCount: 0 });
  });
});

describe('toggleHidden', () => {
  it('hides and shows a column, keeping the list sorted', () => {
    let next = toggleHidden(NO_VIEW, 3, 5);
    next = toggleHidden(next, 1, 5);
    expect(next.hidden).toEqual([1, 3]);
    expect(toggleHidden(next, 1, 5).hidden).toEqual([3]);
  });

  it('keeps the last visible column', () => {
    const almost = view([0, 2], []);
    expect(toggleHidden(almost, 1, 3)).toBe(almost);
  });

  it('lets a hidden column come back even when it is the only one asked about', () => {
    expect(toggleHidden(view([0, 1], []), 0, 3).hidden).toEqual([1]);
  });

  it('counts only columns that exist, so stale indexes do not block hiding', () => {
    expect(toggleHidden(view([7], []), 0, 2).hidden).toEqual([0, 7]);
  });
});

describe('togglePinned', () => {
  it('pins after the existing pins and unpins by index', () => {
    let next = togglePinned(NO_VIEW, 2);
    next = togglePinned(next, 0);
    expect(next.pinned).toEqual([2, 0]);
    expect(togglePinned(next, 2).pinned).toEqual([0]);
  });

  it('leaves the hidden list alone', () => {
    expect(togglePinned(view([4], []), 1).hidden).toEqual([4]);
  });
});

describe('showAll, isCustomized, queries', () => {
  it('shows every column again but keeps the pins', () => {
    expect(showAll(view([1, 2], [0]))).toEqual({ hidden: [], pinned: [0] });
  });

  it('knows whether anything was changed', () => {
    expect(isCustomized(NO_VIEW)).toBe(false);
    expect(isCustomized(view([1], []))).toBe(true);
    expect(isCustomized(view([], [1]))).toBe(true);
  });

  it('answers per column', () => {
    const v = view([1], [2]);
    expect(isHidden(v, 1)).toBe(true);
    expect(isHidden(v, 2)).toBe(false);
    expect(isPinned(v, 2)).toBe(true);
    expect(isPinned(v, 1)).toBe(false);
  });
});

describe('viewKey', () => {
  it('is the same for the same columns and different otherwise', () => {
    expect(viewKey(['a', 'b'])).toBe(viewKey(['a', 'b']));
    expect(viewKey(['a', 'b'])).not.toBe(viewKey(['b', 'a']));
    expect(viewKey(['ab', 'c'])).not.toBe(viewKey(['a', 'bc']));
    expect(viewKey([])).toBe('');
  });
});
