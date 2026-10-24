// How a cell value is shown. NULL must be visible as NULL and never confused with
// the text "NULL", and nothing is ever parsed back from the display text.

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

export function displayOf(value: CellValue): CellDisplay {
  if (value === null) {
    return { text: 'NULL', isNull: true, numeric: false, truncated: false, flattened: false };
  }
  if (typeof value === 'number') {
    return {
      text: String(value),
      isNull: false,
      numeric: true,
      truncated: false,
      flattened: false,
    };
  }
  if (typeof value === 'boolean') {
    return {
      text: value ? 'true' : 'false',
      isNull: false,
      numeric: false,
      truncated: false,
      flattened: false,
    };
  }
  if (typeof value === 'string') {
    return cut(value, false);
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
      case 'decimal':
        return cut(value.text, true);
      case 'datetime':
        return cut(value.text, false);
      case 'json':
        return cut(value.text, false);
      case 'binary':
        return {
          text: `${formatBytes(value.size)} · ${value.preview.slice(0, 32)}${
            value.preview.length > 32 ? '…' : ''
          }`,
          isNull: false,
          numeric: false,
          truncated: value.preview.length > 32,
          flattened: false,
        };
    }
  }
  return { text: '', isNull: false, numeric: false, truncated: false, flattened: false };
}

function cut(text: string, numeric: boolean): CellDisplay {
  // Newlines and tabs would break the single-line cell layout.
  const flat = text.replace(/[\r\n\t]+/gu, ' ');
  const flattened = flat !== text;
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
