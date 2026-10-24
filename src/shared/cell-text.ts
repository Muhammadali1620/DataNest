// The one place that turns a CellValue into text. The grid, "copy as TSV" and the
// exporters all go through it, so what the user sees is what they get — and the
// exact text of a bigint, a decimal or a timestamp is never rounded on the way.

import { type CellValue, isTaggedValue } from './cell-value';

export interface CellTextOptions {
  /** What NULL becomes. Empty by default, which is what CSV and TSV want. */
  readonly nullText?: string;
  /** Marks binary values whose bytes were not all transferred. */
  readonly binarySuffix?: string;
}

/**
 * The full, exact text of a value: no cutting, no whitespace folding. Callers that
 * need a short single line (a grid cell) shorten the result themselves.
 */
export function cellText(value: CellValue, options: CellTextOptions = {}): string {
  const { nullText = '', binarySuffix = '…' } = options;
  if (value === null) {
    return nullText;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
      case 'decimal':
      case 'datetime':
      case 'json':
        // Exactly as the server spelled it.
        return value.text;
      case 'binary':
        return `0x${value.preview}${hasAllBytes(value.size, value.preview) ? '' : binarySuffix}`;
    }
  }
  return '';
}

/** True when the hex preview covers the whole value. */
export function hasAllBytes(size: number, preview: string): boolean {
  return preview.length >= size * 2;
}

/** True for values a grid should right-align and an exporter may leave unquoted. */
export function isNumericValue(value: CellValue): boolean {
  if (typeof value === 'number') {
    return true;
  }
  return isTaggedValue(value) && (value.kind === 'bigint' || value.kind === 'decimal');
}

/** True for values that carry structure a viewer can pretty-print (V2.5). */
export function isStructuredValue(value: CellValue): boolean {
  return isTaggedValue(value) && (value.kind === 'json' || value.kind === 'binary');
}

/**
 * The value as a JSON-ready value: numbers stay numbers, exact-text kinds stay
 * strings so no precision is lost, and JSON columns are embedded as real JSON.
 */
export function cellJson(value: CellValue): unknown {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (isTaggedValue(value)) {
    switch (value.kind) {
      case 'bigint':
      case 'decimal':
        // A JSON number would round these; their text is the faithful form.
        return value.text;
      case 'datetime':
        return value.text;
      case 'json':
        return parseJsonOrText(value.text);
      case 'binary':
        return cellText(value);
    }
  }
  return null;
}

function parseJsonOrText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (_error) {
    // A column that claims to be JSON but is not stays text rather than failing.
    return text;
  }
}
