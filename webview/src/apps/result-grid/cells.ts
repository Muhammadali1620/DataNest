// How a cell value is shown in the grid. The text itself comes from the shared
// serializer, so the grid, "copy as TSV" and the exporters never disagree; only
// the display policy lives here: NULL is labelled, long text is cut, lines folded.

import { cellText, isNumericValue } from '../../../../src/shared/cell-text';
import { type CellValue, isTaggedValue } from '../../../../src/shared/cell-value';

export interface CellDisplay {
  readonly text: string;
  /** NULL is styled differently, so it cannot be mistaken for data. */
  readonly isNull: boolean;
  /** Numbers and friends are right-aligned. */
  readonly numeric: boolean;
  /** Longer than this is cut for display; the full value is still in the host. */
  readonly truncated: boolean;
  /** Newlines or tabs were collapsed, so the cell shows less than the value has. */
  readonly flattened: boolean;
}

/** Characters shown in one cell before it is cut. */
export const MAX_CELL_CHARS = 500;

/** What an empty cell says, so it is never confused with an empty string. */
export const NULL_LABEL = 'NULL';

/** Hex characters of a binary value shown in a cell. */
const BINARY_PREVIEW_CHARS = 32;

export function displayOf(value: CellValue): CellDisplay {
  if (value === null) {
    return { text: NULL_LABEL, isNull: true, numeric: false, truncated: false, flattened: false };
  }
  // Binary is the one kind a cell summarizes rather than shows: the size is what
  // the reader needs, while the clipboard and the exporters carry the hex itself.
  if (isTaggedValue(value) && value.kind === 'binary') {
    const shown = value.preview.slice(0, BINARY_PREVIEW_CHARS);
    const cut = value.preview.length > BINARY_PREVIEW_CHARS;
    return {
      text: `${formatBytes(value.size)} · ${shown}${cut ? '…' : ''}`,
      isNull: false,
      numeric: false,
      truncated: cut,
      flattened: false,
    };
  }
  const numeric = isNumericValue(value);
  // Newlines and tabs would break the single-line cell layout.
  const full = cellText(value);
  const flat = full.replace(/[\r\n\t]+/gu, ' ');
  const flattened = flat !== full;
  if (flat.length <= MAX_CELL_CHARS) {
    return { text: flat, isNull: false, numeric, truncated: false, flattened };
  }
  return {
    text: `${flat.slice(0, MAX_CELL_CHARS)}…`,
    isNull: false,
    numeric,
    truncated: true,
    flattened,
  };
}

export function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
