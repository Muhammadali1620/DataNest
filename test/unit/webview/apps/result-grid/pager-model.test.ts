import { describe, expect, it } from 'vitest';
import {
  currentPage,
  hasNextPage,
  isWholeTable,
  offsetOfPage,
  pageCount,
  pageSizeChoices,
  parsePageSize,
} from '../../../../../webview/src/apps/result-grid/pager-model';

describe('currentPage', () => {
  it('numbers pages from 1', () => {
    expect(currentPage(0, 100)).toBe(1);
    expect(currentPage(99, 100)).toBe(1);
    expect(currentPage(100, 100)).toBe(2);
    expect(currentPage(250, 100)).toBe(3);
  });

  it('survives nonsense', () => {
    expect(currentPage(-5, 100)).toBe(1);
    expect(currentPage(10, 0)).toBe(11);
  });
});

describe('pageCount', () => {
  it('rounds up and has at least one page, even for an empty table', () => {
    expect(pageCount({ offset: 0, pageSize: 100, totalRows: 250 })).toBe(3);
    expect(pageCount({ offset: 0, pageSize: 100, totalRows: 200 })).toBe(2);
    expect(pageCount({ offset: 0, pageSize: 100, totalRows: 0 })).toBe(1);
  });

  it('is unknown without a count and for an estimate', () => {
    expect(pageCount({ offset: 0, pageSize: 100 })).toBeUndefined();
    expect(
      pageCount({ offset: 0, pageSize: 100, totalRows: 5000, approximate: true }),
    ).toBeUndefined();
  });
});

describe('offsetOfPage', () => {
  const exact = { offset: 0, pageSize: 100, totalRows: 250 };

  it('starts the typed page at its first row', () => {
    expect(offsetOfPage(1, exact)).toBe(0);
    expect(offsetOfPage(3, exact)).toBe(200);
  });

  it('clamps to the pages that exist', () => {
    expect(offsetOfPage(99, exact)).toBe(200);
    expect(offsetOfPage(0, exact)).toBe(0);
    expect(offsetOfPage(-4, exact)).toBe(0);
  });

  it('cuts a fraction', () => {
    expect(offsetOfPage(2.9, exact)).toBe(100);
  });

  it('cannot clamp from above without a trustworthy count', () => {
    expect(offsetOfPage(50, { offset: 0, pageSize: 100 })).toBe(4900);
    expect(offsetOfPage(50, { offset: 0, pageSize: 100, totalRows: 10, approximate: true })).toBe(
      4900,
    );
  });

  it('ignores something that is not a number', () => {
    expect(offsetOfPage(Number.NaN, exact)).toBeUndefined();
    expect(offsetOfPage(Number.POSITIVE_INFINITY, exact)).toBeUndefined();
  });
});

describe('hasNextPage', () => {
  it('uses an exact count', () => {
    expect(hasNextPage({ offset: 0, pageSize: 100, totalRows: 250 }, 100)).toBe(true);
    expect(hasNextPage({ offset: 200, pageSize: 100, totalRows: 250 }, 50)).toBe(false);
    expect(hasNextPage({ offset: 100, pageSize: 100, totalRows: 200 }, 100)).toBe(false);
  });

  it('judges by a full page when the count is unknown or only an estimate', () => {
    expect(hasNextPage({ offset: 0, pageSize: 100 }, 100)).toBe(true);
    expect(hasNextPage({ offset: 0, pageSize: 100 }, 40)).toBe(false);
    // The estimate said 100 rows, but the page is full: there is more.
    expect(hasNextPage({ offset: 0, pageSize: 100, totalRows: 100, approximate: true }, 100)).toBe(
      true,
    );
  });
});

describe('pageSizeChoices', () => {
  it('offers the usual sizes in order', () => {
    expect(pageSizeChoices(200)).toEqual([50, 100, 200, 500, 1000, 5000]);
  });

  it('adds an unusual size in its place', () => {
    expect(pageSizeChoices(250)).toEqual([50, 100, 200, 250, 500, 1000, 5000]);
    expect(pageSizeChoices(1_000_000).at(-1)).toBe(1_000_000);
  });
});

describe('isWholeTable', () => {
  it('is true for one page that holds everything', () => {
    expect(isWholeTable({ offset: 0, pageSize: 1000, totalRows: 40 }, 40)).toBe(true);
    expect(isWholeTable({ offset: 0, pageSize: 100, totalRows: 400 }, 100)).toBe(false);
    expect(isWholeTable({ offset: 100, pageSize: 100, totalRows: 150 }, 50)).toBe(false);
  });
});

describe('parsePageSize', () => {
  it('takes a whole number of rows', () => {
    expect(parsePageSize(50)).toBe(50);
    expect(parsePageSize(37)).toBe(37);
    expect(parsePageSize(1)).toBe(1);
  });

  it('cuts a fraction instead of rounding up', () => {
    expect(parsePageSize(49.9)).toBe(49);
  });

  it('caps what the host would refuse', () => {
    expect(parsePageSize(5_000_000)).toBe(1_000_000);
  });

  it.each([0, -5, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('refuses %s', (typed) => {
    expect(parsePageSize(typed)).toBeUndefined();
  });
});

describe('moving by page with an arrow', () => {
  it('can step forward from page 1 whenever rows are left', () => {
    expect(hasNextPage({ offset: 0, pageSize: 50, totalRows: 56 }, 50)).toBe(true);
    expect(offsetOfPage(2, { offset: 0, pageSize: 50, totalRows: 56 })).toBe(50);
  });

  it('stays on page 1 when the whole table fits', () => {
    expect(hasNextPage({ offset: 0, pageSize: 200, totalRows: 56 }, 56)).toBe(false);
    expect(offsetOfPage(2, { offset: 0, pageSize: 200, totalRows: 56 })).toBe(0);
  });
});
