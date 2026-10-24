// Ordering and searching cell values. Both run in the host over the whole result,
// so sorting a million rows does not depend on what the page happens to hold.

import { cellText } from './cell-text';
import { type CellValue, isTaggedValue } from './cell-value';

export type SortDirection = 'asc' | 'desc';

/** Where NULL goes: last when ascending, first when descending. */
function nullRank(value: CellValue): number {
  return value === null ? 1 : 0;
}

/** A number when the value is one, else undefined. */
function numberOf(value: CellValue): number | undefined {
  if (typeof value === 'number') {
    return value;
  }
  if (isTaggedValue(value) && (value.kind === 'bigint' || value.kind === 'decimal')) {
    const parsed = Number(value.text);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/** Exact numeric text compared digit by digit, so no precision is assumed. */
function compareNumericText(left: string, right: string): number {
  const negative = left.startsWith('-');
  if (negative !== right.startsWith('-')) {
    return negative ? -1 : 1;
  }
  const sign = negative ? -1 : 1;
  const [leftInt = '', leftFraction = ''] = left.replace('-', '').split('.');
  const [rightInt = '', rightFraction = ''] = right.replace('-', '').split('.');
  const trimmedLeft = leftInt.replace(/^0+(?=\d)/, '');
  const trimmedRight = rightInt.replace(/^0+(?=\d)/, '');
  if (trimmedLeft.length !== trimmedRight.length) {
    return trimmedLeft.length < trimmedRight.length ? -sign : sign;
  }
  if (trimmedLeft !== trimmedRight) {
    return trimmedLeft < trimmedRight ? -sign : sign;
  }
  const width = Math.max(leftFraction.length, rightFraction.length);
  const paddedLeft = leftFraction.padEnd(width, '0');
  const paddedRight = rightFraction.padEnd(width, '0');
  if (paddedLeft === paddedRight) {
    return 0;
  }
  return paddedLeft < paddedRight ? -sign : sign;
}

const EXACT_NUMERIC = /^-?\d+(\.\d+)?$/;

/**
 * Orders two values of one column. Numbers compare as numbers, text as text, and
 * NULL always sorts after everything so an empty cell never hides a real value.
 */
export function compareCells(left: CellValue, right: CellValue): number {
  const nulls = nullRank(left) - nullRank(right);
  if (nulls !== 0) {
    return nulls;
  }
  if (left === null || right === null) {
    return 0;
  }
  if (typeof left === 'boolean' || typeof right === 'boolean') {
    return Number(left === true) - Number(right === true);
  }
  const leftText = cellText(left);
  const rightText = cellText(right);
  // Exact numeric text is compared without going through a double.
  if (EXACT_NUMERIC.test(leftText) && EXACT_NUMERIC.test(rightText)) {
    return compareNumericText(leftText, rightText);
  }
  const leftNumber = numberOf(left);
  const rightNumber = numberOf(right);
  if (leftNumber !== undefined && rightNumber !== undefined) {
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }
  // Numbers before text, so a mixed column still has a stable order.
  if (leftNumber !== undefined) {
    return -1;
  }
  if (rightNumber !== undefined) {
    return 1;
  }
  return leftText.localeCompare(rightText, undefined, { numeric: true, sensitivity: 'variant' });
}

/**
 * Rows ordered by one column. The sort is stable, so rows that compare equal keep
 * the order the server returned them in.
 */
export function sortRows<T extends readonly CellValue[]>(
  rows: readonly T[],
  column: number,
  direction: SortDirection,
): T[] {
  const sign = direction === 'desc' ? -1 : 1;
  return [...rows]
    .map((row, index) => ({ row, index }))
    .sort((left, right) => {
      const compared = compareCells(left.row[column] ?? null, right.row[column] ?? null);
      // NULLs stay last in both directions: they are absence, not a value.
      if (compared !== 0) {
        const leftNull = left.row[column] === null;
        const rightNull = right.row[column] === null;
        if (leftNull !== rightNull) {
          return leftNull ? 1 : -1;
        }
        return compared * sign;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.row);
}
