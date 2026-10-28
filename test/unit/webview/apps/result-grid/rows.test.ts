import { describe, expect, it } from 'vitest';
import { MAX_WINDOW_ROWS, WINDOW_OVERSCAN } from '../../../../../src/shared/protocols/result-grid';
import { RowCache, windowFor } from '../../../../../webview/src/apps/result-grid/rows';

describe('windowFor', () => {
  it('asks for the visible span plus the overscan', () => {
    expect(windowFor(100, 20, 1000)).toEqual({
      offset: 100 - WINDOW_OVERSCAN,
      limit: 20 + WINDOW_OVERSCAN * 2,
    });
  });

  it('does not ask for rows before the first one', () => {
    expect(windowFor(0, 20, 1000)).toEqual({ offset: 0, limit: 20 + WINDOW_OVERSCAN });
  });

  it('stops at the last row', () => {
    const range = windowFor(990, 20, 1000);
    expect(range?.offset).toBe(990 - WINDOW_OVERSCAN);
    expect((range?.offset ?? 0) + (range?.limit ?? 0)).toBe(1000);
  });

  it('never asks for more than one window holds', () => {
    const range = windowFor(0, 100_000, 1_000_000);
    expect(range?.limit).toBe(MAX_WINDOW_ROWS);
  });

  it('has nothing to ask for in an empty result or with nothing visible', () => {
    expect(windowFor(0, 20, 0)).toBeUndefined();
    expect(windowFor(0, 0, 100)).toBeUndefined();
  });

  it('clamps a first row past the end', () => {
    expect(windowFor(5000, 10, 100)?.offset).toBeLessThan(100);
  });

  it('accepts a fractional scroll position', () => {
    expect(windowFor(10.7, 5.2, 100)).toEqual(windowFor(10, 5, 100));
  });
});

describe('RowCache', () => {
  it('starts empty', () => {
    const cache = new RowCache();
    expect(cache.rowCount).toBe(0);
    expect(cache.loadedCount).toBe(0);
    expect(cache.get(0)).toBeUndefined();
  });

  it('keeps the rows of a window at their real indexes', () => {
    const cache = new RowCache();
    cache.put(10, [[1], [2], [3]], 100);
    expect(cache.rowCount).toBe(100);
    expect(cache.get(10)).toEqual([1]);
    expect(cache.get(12)).toEqual([3]);
    expect(cache.get(13)).toBeUndefined();
    expect(cache.has(11)).toBe(true);
    expect(cache.has(9)).toBe(false);
  });

  it('merges windows that arrive out of order', () => {
    const cache = new RowCache();
    cache.put(10, [[10]], 100);
    cache.put(0, [[0]], 100);
    expect(cache.get(0)).toEqual([0]);
    expect(cache.get(10)).toEqual([10]);
    expect(cache.loadedCount).toBe(2);
  });

  it('drops rows past the end when the result turns out shorter', () => {
    const cache = new RowCache();
    cache.put(0, [[1], [2], [3]], 3);
    cache.put(0, [[9]], 1);
    expect(cache.rowCount).toBe(1);
    expect(cache.get(0)).toEqual([9]);
    expect(cache.get(1)).toBeUndefined();
    expect(cache.loadedCount).toBe(1);
  });

  it('ignores rows beyond the reported count', () => {
    const cache = new RowCache();
    cache.put(0, [[1], [2], [3]], 2);
    expect(cache.loadedCount).toBe(2);
  });

  it('reset forgets everything', () => {
    const cache = new RowCache();
    cache.put(0, [[1]], 10);
    cache.reset(5);
    expect(cache.rowCount).toBe(5);
    expect(cache.loadedCount).toBe(0);
    cache.reset();
    expect(cache.rowCount).toBe(0);
  });

  describe('hasRange', () => {
    it('is true only when every row of the range is loaded', () => {
      const cache = new RowCache();
      cache.put(0, [[0], [1], [2]], 10);
      expect(cache.hasRange(0, 3)).toBe(true);
      expect(cache.hasRange(0, 4)).toBe(false);
      expect(cache.hasRange(1, 2)).toBe(true);
      expect(cache.hasRange(5, 1)).toBe(false);
    });

    it('stops at the end of the result, so the last window counts as complete', () => {
      const cache = new RowCache();
      cache.put(0, [[0], [1]], 2);
      expect(cache.hasRange(0, 100)).toBe(true);
    });

    it('treats a negative offset as the start', () => {
      const cache = new RowCache();
      cache.put(0, [[0]], 1);
      expect(cache.hasRange(-5, 1)).toBe(true);
    });

    it('is true for an empty result, which needs no request', () => {
      expect(new RowCache().hasRange(0, 10)).toBe(true);
    });
  });
});

describe('RowCache change marks', () => {
  it('remembers which cells have a pending change', () => {
    const cache = new RowCache();
    cache.reset(3);
    cache.put(0, [[1], [2], [3]], 3, [
      { row: 1, column: 0, kind: 'value' },
      { row: 2, column: 0, kind: 'default' },
    ]);
    expect(cache.changeAt(0, 0)).toBeUndefined();
    expect(cache.changeAt(1, 0)).toBe('value');
    expect(cache.changeAt(2, 0)).toBe('default');
  });

  it('lets a newer window replace the marks of its rows, and only those', () => {
    const cache = new RowCache();
    cache.reset(4);
    cache.put(0, [[1], [2], [3], [4]], 4, [
      { row: 0, column: 0, kind: 'value' },
      { row: 3, column: 0, kind: 'value' },
    ]);
    cache.put(0, [[1], [2]], 4, []);
    expect(cache.changeAt(0, 0)).toBeUndefined();
    expect(cache.changeAt(3, 0)).toBe('value');
  });

  it('drops marks past a result that shrank, and all of them on reset', () => {
    const cache = new RowCache();
    cache.reset(3);
    cache.put(0, [[1], [2], [3]], 3, [{ row: 2, column: 0, kind: 'value' }]);
    cache.put(0, [[1]], 1);
    expect(cache.changeAt(2, 0)).toBeUndefined();
    cache.put(0, [[1]], 1, [{ row: 0, column: 0, kind: 'default' }]);
    cache.reset(1);
    expect(cache.changeAt(0, 0)).toBeUndefined();
  });
});
