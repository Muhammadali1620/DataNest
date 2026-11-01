// How roomy the result grid looks by default (V13.3): the height of its rows and the
// widest a column gets on its own. The settings name a row height, the page turns it
// into pixels, and both sides read a hand-edited value through `normalizeColumnLimit`.

export const ROW_DENSITIES = ['compact', 'normal', 'comfortable'] as const;
export type RowDensity = (typeof ROW_DENSITIES)[number];

/** Row height in pixels per density; "normal" is what the grid always had. */
export const ROW_DENSITY_HEIGHT: Readonly<Record<RowDensity, number>> = {
  compact: 24,
  normal: 32,
  comfortable: 40,
};

/** The narrowest and the widest limit for a column's own width. */
export const MIN_COLUMN_LIMIT = 120;
export const MAX_COLUMN_LIMIT = 1600;
export const DEFAULT_COLUMN_LIMIT = 420;

export interface ResultsLook {
  /** Row height in pixels. */
  readonly rowHeight: number;
  /** Widest a column gets without being dragged, in pixels. */
  readonly maxColumnWidth: number;
}

export const DEFAULT_LOOK: ResultsLook = {
  rowHeight: ROW_DENSITY_HEIGHT.normal,
  maxColumnWidth: DEFAULT_COLUMN_LIMIT,
};

export function isRowDensity(value: unknown): value is RowDensity {
  return ROW_DENSITIES.includes(value as RowDensity);
}

/** The density whose height this is, if it is one of the three. */
export function densityOfHeight(rowHeight: number): RowDensity | undefined {
  return ROW_DENSITIES.find((density) => ROW_DENSITY_HEIGHT[density] === rowHeight);
}

/** A column limit as a whole number inside the allowed range; anything else is the default. */
export function normalizeColumnLimit(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.min(MAX_COLUMN_LIMIT, Math.max(MIN_COLUMN_LIMIT, Math.round(value)))
    : DEFAULT_COLUMN_LIMIT;
}

/** The look for the two settings as the user wrote them; wrong values fall back. */
export function lookFromSettings(density: unknown, maxColumnWidth: unknown): ResultsLook {
  return {
    rowHeight: ROW_DENSITY_HEIGHT[isRowDensity(density) ? density : 'normal'],
    maxColumnWidth: normalizeColumnLimit(maxColumnWidth),
  };
}
