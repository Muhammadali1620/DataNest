// Which cells are selected and where the keyboard moves next. Pure arithmetic on
// indexes: the grid draws whatever this says, and every rule is a unit test.

export interface CellRef {
  readonly row: number;
  readonly column: number;
}

/**
 * A rectangle between the cell the user started from and the one they are on.
 * Keeping both ends (rather than a normalized box) is what makes shift+arrow
 * grow and shrink from the right side.
 */
export interface Selection {
  readonly anchor: CellRef;
  readonly focus: CellRef;
}

export interface Bounds {
  readonly rowCount: number;
  readonly columnCount: number;
}

export interface SelectionBox {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

export function selectionBox(selection: Selection): SelectionBox {
  return {
    top: Math.min(selection.anchor.row, selection.focus.row),
    bottom: Math.max(selection.anchor.row, selection.focus.row),
    left: Math.min(selection.anchor.column, selection.focus.column),
    right: Math.max(selection.anchor.column, selection.focus.column),
  };
}

export function isSelected(selection: Selection | undefined, row: number, column: number): boolean {
  if (selection === undefined) {
    return false;
  }
  const box = selectionBox(selection);
  return row >= box.top && row <= box.bottom && column >= box.left && column <= box.right;
}

export function isFocused(selection: Selection | undefined, row: number, column: number): boolean {
  return selection?.focus.row === row && selection.focus.column === column;
}

/** How many cells the selection covers. */
export function selectionSize(selection: Selection): number {
  const box = selectionBox(selection);
  return (box.bottom - box.top + 1) * (box.right - box.left + 1);
}

function clampRef(ref: CellRef, bounds: Bounds): CellRef {
  return {
    row: Math.max(0, Math.min(ref.row, bounds.rowCount - 1)),
    column: Math.max(0, Math.min(ref.column, bounds.columnCount - 1)),
  };
}

/** A selection of exactly one cell, kept inside the grid. */
export function selectCell(ref: CellRef, bounds: Bounds): Selection | undefined {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0) {
    return undefined;
  }
  const cell = clampRef(ref, bounds);
  return { anchor: cell, focus: cell };
}

/** Moves the focus while keeping the anchor, which is what dragging does. */
export function extendTo(
  selection: Selection | undefined,
  ref: CellRef,
  bounds: Bounds,
): Selection | undefined {
  if (selection === undefined) {
    return selectCell(ref, bounds);
  }
  return { anchor: selection.anchor, focus: clampRef(ref, bounds) };
}

export function selectAll(bounds: Bounds): Selection | undefined {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0) {
    return undefined;
  }
  return {
    anchor: { row: 0, column: 0 },
    focus: { row: bounds.rowCount - 1, column: bounds.columnCount - 1 },
  };
}

/** Keys the grid understands; anything else is left to the host. */
export type NavigationKey =
  'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight' | 'Home' | 'End' | 'PageUp' | 'PageDown';

export interface NavigationOptions {
  /** Shift: keep the anchor and move only the focus. */
  readonly extend?: boolean;
  /** Ctrl/Cmd: jump to the edge instead of one step. */
  readonly jump?: boolean;
  /** Rows one PageUp/PageDown covers. */
  readonly pageRows?: number;
}

/**
 * Where the focus lands after a navigation key. Returns the same selection when
 * the move would leave the grid, so holding a key at the edge does nothing.
 */
export function navigate(
  selection: Selection | undefined,
  key: NavigationKey,
  bounds: Bounds,
  options: NavigationOptions = {},
): Selection | undefined {
  if (bounds.rowCount <= 0 || bounds.columnCount <= 0) {
    return undefined;
  }
  if (selection === undefined) {
    return selectCell({ row: 0, column: 0 }, bounds);
  }
  const { extend = false, jump = false, pageRows = 20 } = options;
  const from = selection.focus;
  const lastRow = bounds.rowCount - 1;
  const lastColumn = bounds.columnCount - 1;
  let next: CellRef;
  switch (key) {
    case 'ArrowUp':
      next = { row: jump ? 0 : from.row - 1, column: from.column };
      break;
    case 'ArrowDown':
      next = { row: jump ? lastRow : from.row + 1, column: from.column };
      break;
    case 'ArrowLeft':
      next = { row: from.row, column: jump ? 0 : from.column - 1 };
      break;
    case 'ArrowRight':
      next = { row: from.row, column: jump ? lastColumn : from.column + 1 };
      break;
    case 'Home':
      next = jump ? { row: 0, column: 0 } : { row: from.row, column: 0 };
      break;
    case 'End':
      next = jump ? { row: lastRow, column: lastColumn } : { row: from.row, column: lastColumn };
      break;
    case 'PageUp':
      next = { row: from.row - Math.max(1, pageRows), column: from.column };
      break;
    case 'PageDown':
      next = { row: from.row + Math.max(1, pageRows), column: from.column };
      break;
  }
  const focus = clampRef(next, bounds);
  return extend ? { anchor: selection.anchor, focus } : { anchor: focus, focus };
}

export function isNavigationKey(key: string): key is NavigationKey {
  return (
    key === 'ArrowUp' ||
    key === 'ArrowDown' ||
    key === 'ArrowLeft' ||
    key === 'ArrowRight' ||
    key === 'Home' ||
    key === 'End' ||
    key === 'PageUp' ||
    key === 'PageDown'
  );
}
