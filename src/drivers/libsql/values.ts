// Values of Hrana (the wire format of libSQL servers) and the ones DataNest keeps in cells.
// Integers travel as decimal text, so nothing is rounded on the way (shared/cell-value.ts).

import type { CellValue } from '../../shared/cell-value';
import { binaryValue, safeIntOrTag } from '../common/values';

export type HranaValue =
  | { readonly type: 'null' }
  | { readonly type: 'integer'; readonly value: string }
  | { readonly type: 'float'; readonly value: number }
  | { readonly type: 'text'; readonly value: string }
  | { readonly type: 'blob'; readonly base64: string };

/** What a metadata lookup may bind (the same as the SQLite driver's). */
export type LibsqlParam = null | string | number;

export function toHranaValue(param: LibsqlParam): HranaValue {
  if (param === null) {
    return { type: 'null' };
  }
  if (typeof param === 'string') {
    return { type: 'text', value: param };
  }
  return Number.isInteger(param)
    ? { type: 'integer', value: String(param) }
    : { type: 'float', value: param };
}

/** A cell as the server sent it; unknown shapes stay readable as JSON text. */
export function fromHranaValue(value: unknown): CellValue {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const cell = value as { type?: unknown; value?: unknown; base64?: unknown };
  switch (cell.type) {
    case 'null':
      return null;
    case 'integer':
      return typeof cell.value === 'string' || typeof cell.value === 'number'
        ? safeIntOrTag(String(cell.value))
        : null;
    case 'float':
      return typeof cell.value === 'number' && Number.isFinite(cell.value) ? cell.value : null;
    case 'text':
      return typeof cell.value === 'string' ? cell.value : null;
    case 'blob':
      return typeof cell.base64 === 'string'
        ? binaryValue(new Uint8Array(Buffer.from(cell.base64, 'base64')))
        : null;
    default:
      return { kind: 'json', text: JSON.stringify(value) };
  }
}
