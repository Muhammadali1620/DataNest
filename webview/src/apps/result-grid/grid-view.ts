// How the user likes the grid drawn: row height, text size, lines and the gutter.
// Pure helpers, so the rules for a stored (possibly stale or hand-edited) value are tested.

export type GridLines = 'none' | 'rows' | 'columns' | 'all';
export type GridLayout = 'table' | 'json' | 'transposed';
export type GridFont = 'ui' | 'mono';
export type GridAlign = 'auto' | 'left' | 'center' | 'right';

export interface GridView {
  /** How the rows are laid out: the table, as JSON, or turned so fields run down. */
  readonly layout: GridLayout;
  readonly rowHeight: number;
  readonly fontSize: number;
  readonly lines: GridLines;
  readonly align: GridAlign;
  /** Show the row's number in the gutter. */
  readonly rowNumbers: boolean;
  /** Show a check box per row, for actions on several rows at once. */
  readonly checkboxes: boolean;
  readonly font: GridFont;
  /** Show how long the statement took in the status bar. */
  readonly showTime: boolean;
  /** Columns can be dragged by their header into another place. */
  readonly draggableColumns: boolean;
}

export const MIN_ROW_HEIGHT = 20;
export const MAX_ROW_HEIGHT = 64;
export const ROW_HEIGHT_STEP = 2;
export const GRID_LAYOUTS: readonly GridLayout[] = ['table', 'json', 'transposed'];
export const GRID_FONTS: readonly GridFont[] = ['ui', 'mono'];
export const FONT_SIZES = [12, 13, 14, 15, 16] as const;
export const GRID_LINES: readonly GridLines[] = ['none', 'rows', 'columns', 'all'];
export const GRID_ALIGNS: readonly GridAlign[] = ['auto', 'left', 'center', 'right'];

export const DEFAULT_VIEW: GridView = {
  layout: 'table',
  rowHeight: 32,
  fontSize: 14,
  lines: 'rows',
  align: 'auto',
  rowNumbers: true,
  checkboxes: true,
  font: 'ui',
  showTime: true,
  draggableColumns: false,
};

export const VIEW_STORAGE_KEY = 'datanest.grid.view';

function oneOf<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback;
}

/** Whatever was stored, turned into a valid view: unknown or wrong fields fall back. */
export function normalizeView(raw: unknown): GridView {
  const source: Partial<Record<keyof GridView, unknown>> =
    typeof raw === 'object' && raw !== null ? raw : {};
  const height = source.rowHeight;
  return {
    layout: oneOf(source.layout, GRID_LAYOUTS, DEFAULT_VIEW.layout),
    rowHeight:
      typeof height === 'number' && Number.isFinite(height)
        ? Math.min(MAX_ROW_HEIGHT, Math.max(MIN_ROW_HEIGHT, Math.round(height)))
        : DEFAULT_VIEW.rowHeight,
    fontSize: oneOf(source.fontSize, FONT_SIZES, DEFAULT_VIEW.fontSize),
    lines: oneOf(source.lines, GRID_LINES, DEFAULT_VIEW.lines),
    align: oneOf(source.align, GRID_ALIGNS, DEFAULT_VIEW.align),
    rowNumbers: typeof source.rowNumbers === 'boolean' ? source.rowNumbers : true,
    checkboxes: typeof source.checkboxes === 'boolean' ? source.checkboxes : true,
    font: oneOf(source.font, GRID_FONTS, DEFAULT_VIEW.font),
    showTime: typeof source.showTime === 'boolean' ? source.showTime : true,
    draggableColumns:
      typeof source.draggableColumns === 'boolean' ? source.draggableColumns : false,
  };
}

/** The header shows the name and, under it, the type: a little over two text lines. */
export function headerHeight(view: GridView): number {
  return Math.round(view.fontSize * 3.3);
}

const EXPANDER_WIDTH = 24;

/** Width of the gutter before the first column: arrow, check box and/or row number. */
export function gutterWidth(view: GridView, digits: number): number {
  const number = view.rowNumbers ? 14 + Math.max(2, digits) * 9 : 0;
  const box = view.checkboxes ? 34 : 0;
  // The arrow that opens a row's details is always there.
  return Math.max(16, EXPANDER_WIDTH + box + number + 10);
}

export function loadView(storage: Pick<Storage, 'getItem'> | undefined): GridView {
  try {
    const text = storage?.getItem(VIEW_STORAGE_KEY);
    return text === null || text === undefined ? DEFAULT_VIEW : normalizeView(JSON.parse(text));
  } catch {
    return DEFAULT_VIEW;
  }
}

export function saveView(storage: Pick<Storage, 'setItem'> | undefined, view: GridView): void {
  try {
    storage?.setItem(VIEW_STORAGE_KEY, JSON.stringify(view));
  } catch {
    // Storage can be blocked; the view then lasts until the page closes.
  }
}

/** Rows ticked in the gutter: "all" with exceptions, so a huge result costs nothing. */
export interface Ticks {
  readonly all: boolean;
  /** Rows whose box differs from `all`. */
  readonly flipped: ReadonlySet<number>;
}

export const NO_TICKS: Ticks = { all: false, flipped: new Set() };

export function isTicked(ticks: Ticks, row: number): boolean {
  return ticks.all !== ticks.flipped.has(row);
}

export function toggleTick(ticks: Ticks, row: number): Ticks {
  const flipped = new Set(ticks.flipped);
  if (!flipped.delete(row)) {
    flipped.add(row);
  }
  return { all: ticks.all, flipped };
}

/** The header box: ticks every row, or clears them when everything is ticked already. */
export function toggleAllTicks(ticks: Ticks, rowCount: number): Ticks {
  return tickedCount(ticks, rowCount) === rowCount && rowCount > 0
    ? NO_TICKS
    : { all: true, flipped: new Set() };
}

export function tickedCount(ticks: Ticks, rowCount: number): number {
  const inRange = [...ticks.flipped].filter((row) => row >= 0 && row < rowCount).length;
  return ticks.all ? rowCount - inRange : inRange;
}

export function tickedRows(ticks: Ticks, rowCount: number): number[] {
  if (!ticks.all) {
    return [...ticks.flipped].filter((row) => row >= 0 && row < rowCount).sort((a, b) => a - b);
  }
  return Array.from({ length: rowCount }, (_, row) => row).filter((row) => !ticks.flipped.has(row));
}
