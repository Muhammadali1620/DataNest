// Normalization of node:sqlite values. The worker reads integers as bigint
// (setReadBigInts), so nothing is rounded before it gets here.

import type { CellValue } from '../../shared/cell-value';
import { binaryValue, safeIntOrTag } from '../common/values';

export function toCellValue(value: unknown): CellValue {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'bigint') {
    return safeIntOrTag(value.toString());
  }
  if (value instanceof Uint8Array) {
    return binaryValue(value);
  }
  // SQLite has no other value kinds; keep anything exotic readable.
  const text = JSON.stringify(value) as string | undefined;
  return { kind: 'json', text: text ?? '[unserializable]' };
}
