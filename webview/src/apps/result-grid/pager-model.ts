// Arithmetic of the pager: which page an offset is on, where a page starts, which
// page sizes to offer. Pure, so the edge cases (empty table, last short page, an
// estimate that turned out too low) are unit tests.

/** The page sizes on offer; the current one is added when it is not among them. */
export const PAGE_SIZE_CHOICES = [50, 100, 200, 500, 1000, 5000] as const;

export interface PageInfo {
  readonly offset: number;
  readonly pageSize: number;
  readonly totalRows?: number | undefined;
  readonly approximate?: boolean | undefined;
}

/** 1-based number of the page that holds the offset. */
export function currentPage(offset: number, pageSize: number): number {
  return Math.floor(Math.max(0, offset) / Math.max(1, pageSize)) + 1;
}

/** How many pages there are, or undefined while the row count is unknown or an estimate. */
export function pageCount(page: PageInfo): number | undefined {
  if (page.totalRows === undefined || page.approximate === true) {
    return undefined;
  }
  return Math.max(1, Math.ceil(page.totalRows / Math.max(1, page.pageSize)));
}

/**
 * Offset of a typed page number. Without a trustworthy page count nothing can be
 * clamped from above, and the server simply answers with an empty page.
 */
export function offsetOfPage(requested: number, page: PageInfo): number | undefined {
  if (!Number.isFinite(requested)) {
    return undefined;
  }
  const count = pageCount(page);
  const number = Math.max(1, Math.min(Math.trunc(requested), count ?? Number.MAX_SAFE_INTEGER));
  return (number - 1) * page.pageSize;
}

/** True when there may be rows after this page. */
export function hasNextPage(page: PageInfo, rowsOnPage: number): boolean {
  if (page.totalRows !== undefined && page.approximate !== true) {
    return page.offset + rowsOnPage < page.totalRows;
  }
  // An estimate or no count at all: a full page means there could be more.
  return rowsOnPage >= page.pageSize;
}

/** Most rows one page may hold; the host refuses more. */
export const MAX_PAGE_ROWS = 1_000_000;

/** A typed page size as a whole number of rows, or undefined when it is not one. */
export function parsePageSize(typed: number): number | undefined {
  if (!Number.isFinite(typed) || typed < 1) {
    return undefined;
  }
  return Math.min(MAX_PAGE_ROWS, Math.trunc(typed));
}

/** The choices for a size picker, in order, always including the size in use. */
export function pageSizeChoices(current: number): number[] {
  const all = new Set<number>([...PAGE_SIZE_CHOICES, current]);
  return [...all].sort((a, b) => a - b);
}

/** True when the page already holds the whole table, so paging has nothing to offer. */
export function isWholeTable(page: PageInfo, rowsOnPage: number): boolean {
  return page.offset === 0 && !hasNextPage(page, rowsOnPage);
}
