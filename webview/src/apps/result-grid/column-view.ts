// Which columns the grid shows and in what order: hidden ones are left out and
// pinned ones come first and stay put while the rest scrolls. Pure, so the rules
// (a hidden column cannot be pinned on screen, the order of pins is the order they
// were pinned in) are unit tests. Column indexes are always the result's own.

export interface ColumnView {
  /** Columns the user hid. */
  readonly hidden: readonly number[];
  /** Pinned columns, in the order they were pinned. */
  readonly pinned: readonly number[];
  /** The order the user dragged the columns into; the result's own order when absent. */
  readonly order?: readonly number[];
}

export const NO_VIEW: ColumnView = { hidden: [], pinned: [] };

export interface DisplayOrder {
  /** Result column indexes in the order they are drawn: pinned first, hidden left out. */
  readonly order: readonly number[];
  /** How many of the leading entries are pinned. */
  readonly pinnedCount: number;
}

/** The dragged order made complete: unknown or repeated entries dropped, missing ones appended. */
function baseOrder(columnCount: number, order: readonly number[] | undefined): number[] {
  const count = Math.max(0, columnCount);
  const seen = new Set<number>();
  const result: number[] = [];
  for (const index of order ?? []) {
    if (Number.isInteger(index) && index >= 0 && index < count && !seen.has(index)) {
      seen.add(index);
      result.push(index);
    }
  }
  for (let index = 0; index < count; index += 1) {
    if (!seen.has(index)) {
      result.push(index);
    }
  }
  return result;
}

/** Moves a column to stand just before another one (or last when `before` is undefined). */
export function moveColumn(
  view: ColumnView,
  columnCount: number,
  from: number,
  before: number | undefined,
): ColumnView {
  const order = baseOrder(columnCount, view.order);
  if (!order.includes(from) || from === before) {
    return view;
  }
  const without = order.filter((index) => index !== from);
  const at = before === undefined ? without.length : without.indexOf(before);
  without.splice(at === -1 ? without.length : at, 0, from);
  return { ...view, order: without };
}

export function displayOrder(columnCount: number, view: ColumnView): DisplayOrder {
  const hidden = new Set(view.hidden);
  const valid = (index: number): boolean =>
    Number.isInteger(index) && index >= 0 && index < columnCount && !hidden.has(index);
  const pinned = [...new Set(view.pinned)].filter(valid);
  const pinnedSet = new Set(pinned);
  const rest = baseOrder(columnCount, view.order).filter(
    (index) => valid(index) && !pinnedSet.has(index),
  );
  return { order: [...pinned, ...rest], pinnedCount: pinned.length };
}

export function isHidden(view: ColumnView, index: number): boolean {
  return view.hidden.includes(index);
}

export function isPinned(view: ColumnView, index: number): boolean {
  return view.pinned.includes(index);
}

/**
 * Hides or shows a column. The last visible column cannot be hidden: a grid with
 * no columns shows nothing to click on to get them back.
 */
export function toggleHidden(view: ColumnView, index: number, columnCount: number): ColumnView {
  if (isHidden(view, index)) {
    return { ...view, hidden: view.hidden.filter((candidate) => candidate !== index) };
  }
  const visible = displayOrder(columnCount, view).order;
  if (visible.length <= 1 && visible.includes(index)) {
    return view;
  }
  return { ...view, hidden: [...view.hidden, index].sort((a, b) => a - b) };
}

/** Pins or unpins a column; a newly pinned column goes after the ones already pinned. */
export function togglePinned(view: ColumnView, index: number): ColumnView {
  return isPinned(view, index)
    ? { ...view, pinned: view.pinned.filter((candidate) => candidate !== index) }
    : { ...view, pinned: [...view.pinned, index] };
}

export function showAll(view: ColumnView): ColumnView {
  return { ...view, hidden: [] };
}

/** True when the view differs from "everything, in order". */
export function isCustomized(view: ColumnView): boolean {
  return (
    view.hidden.length > 0 ||
    view.pinned.length > 0 ||
    view.order?.some((index, at) => index !== at) === true
  );
}

/**
 * What identifies "the same table or query result" across pages and re-runs: a view
 * made for these columns applies to the next page of them, not to a different result.
 */
export function viewKey(columnNames: readonly string[]): string {
  return columnNames.join('\u0000');
}
