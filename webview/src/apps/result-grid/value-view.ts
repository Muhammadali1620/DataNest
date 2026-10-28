// What the value panel shows for a cell: text, JSON or bytes.

import { type CellValue, isTaggedValue } from '../../../../src/shared/cell-value';
import { cellText } from '../../../../src/shared/cell-text';
import { isJsonDocument, isValidJson } from './json-view';

export type ValueView =
  | { readonly kind: 'null' }
  | {
      readonly kind: 'text';
      readonly text: string;
      /** A JSON column, or text that is a complete JSON object or array. */
      readonly json: boolean;
      /** False for a JSON column whose text does not parse. */
      readonly valid: boolean;
    }
  | { readonly kind: 'binary'; readonly size: number; readonly preview: string };

export function viewOf(cell: CellValue): ValueView {
  if (cell === null) {
    return { kind: 'null' };
  }
  if (isTaggedValue(cell)) {
    if (cell.kind === 'binary') {
      return { kind: 'binary', size: cell.size, preview: cell.preview };
    }
    if (cell.kind === 'json') {
      return { kind: 'text', text: cell.text, json: true, valid: isValidJson(cell.text) };
    }
  }
  const text = cellText(cell);
  const json = typeof cell === 'string' && isJsonDocument(text);
  return { kind: 'text', text, json, valid: json };
}

/** Characters of text and lines, for the panel's header. */
export function textStats(text: string): { chars: number; lines: number } {
  let lines = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) {
      lines += 1;
    }
  }
  return { chars: text.length, lines };
}
