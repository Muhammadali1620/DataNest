// Ordering and searching cell values. Both run in the host over the whole result,
// so sorting a million rows does not depend on what the page happens to hold.

import { cellText } from './cell-text';
import { type CellValue, isTaggedValue } from './cell-value';
import { mergeSortSteps, type PauseOptions, runSteps, runStepsPaused } from './merge-sort';

export type SortDirection = 'asc' | 'desc';

/** Text is ordered the way a person reads it: case-insensitively first, numbers by value. */
const COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'variant' });

/** Exact numeric text split once, so comparing it needs no string surgery. */
interface ExactNumber {
  readonly negative: boolean;
  /** Integer digits without leading zeros. */
  readonly integer: string;
  /** Fraction digits without trailing zeros. */
  readonly fraction: string;
}

const EXACT_NUMERIC = /^-?\d+(\.\d+)?$/;

const NULL = 0;
const BOOLEAN = 1;
const VALUE = 2;

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

function exactOf(text: string): ExactNumber {
  const negative = text.startsWith('-');
  const [integer = '', fraction = ''] = (negative ? text.slice(1) : text).split('.');
  return {
    negative,
    integer: integer.replace(/^0+(?=\d)/, ''),
    fraction: fraction.replace(/0+$/, ''),
  };
}

/** Exact numbers compared digit by digit, so no precision is assumed. */
function compareExact(left: ExactNumber, right: ExactNumber): number {
  if (left.negative !== right.negative) {
    return left.negative ? -1 : 1;
  }
  const sign = left.negative ? -1 : 1;
  if (left.integer.length !== right.integer.length) {
    return left.integer.length < right.integer.length ? -sign : sign;
  }
  if (left.integer !== right.integer) {
    return left.integer < right.integer ? -sign : sign;
  }
  // Without trailing zeros, plain text order of the fractions is their numeric order.
  if (left.fraction === right.fraction) {
    return 0;
  }
  return left.fraction < right.fraction ? -sign : sign;
}

/** Items of work between two yields while keys are built. */
const KEY_STEP = 2048;

/**
 * What ordering needs of each cell of a column, worked out once and kept in typed
 * arrays: a sort compares these instead of the values, so the text, the number and
 * the exact digits of a cell are not redone on each of the twenty-odd comparisons a
 * row takes part in — and a million cells do not become a million objects.
 */
class ColumnKeys {
  readonly kind: Uint8Array;
  /** 1 for `true`; booleans compare that way with any value. */
  readonly truth: Uint8Array;
  /** 1 when the cell's text is an exact number like `-12.50`. */
  readonly exact: Uint8Array;
  /**
   * 1 when the cell's exact text has at most 15 digits: a double holds such a number
   * exactly enough that comparing doubles gives the order of the digits.
   */
  readonly fits: Uint8Array;
  readonly hasNumber: Uint8Array;
  readonly numbers: Float64Array;
  /** Place of the cell's text among the column's texts; only for cells that have no number. */
  readonly rank: Int32Array;
  /** Exact digits of long numbers, worked out when first compared. */
  private readonly digits: (ExactNumber | undefined)[];

  constructor(
    private readonly valueAt: (index: number) => CellValue | undefined,
    length: number,
  ) {
    this.kind = new Uint8Array(length);
    this.truth = new Uint8Array(length);
    this.exact = new Uint8Array(length);
    this.fits = new Uint8Array(length);
    this.hasNumber = new Uint8Array(length);
    this.numbers = new Float64Array(length);
    this.rank = new Int32Array(length);
    this.digits = new Array<ExactNumber | undefined>(length);
  }

  /** Fills the keys, ordering each distinct text once with the collator. */
  *build(): Generator<void, this, void> {
    const length = this.kind.length;
    const ids = new Map<string, number>();
    const textOf = new Int32Array(length).fill(-1);
    for (let index = 0; index < length; index++) {
      const value = this.valueAt(index);
      if (value === null || value === undefined) {
        this.kind[index] = NULL;
      } else if (typeof value === 'boolean') {
        this.kind[index] = BOOLEAN;
        this.truth[index] = value ? 1 : 0;
      } else {
        this.kind[index] = VALUE;
        const text = cellText(value);
        const number = numberOf(value);
        if (EXACT_NUMERIC.test(text)) {
          this.exact[index] = 1;
          // Sign and point are not digits; leading and trailing zeros are counted, which
          // only sends a few more numbers the slow, always exact way.
          if (text.length - Number(text.startsWith('-')) - Number(text.includes('.')) <= 15) {
            this.fits[index] = 1;
            if (number === undefined) {
              // Numeric text of a string cell: its number is only for the exact comparison.
              this.numbers[index] = Number(text);
            }
          }
        }
        if (number === undefined) {
          let id = ids.get(text);
          if (id === undefined) {
            id = ids.size;
            ids.set(text, id);
          }
          textOf[index] = id;
        } else {
          this.hasNumber[index] = 1;
          this.numbers[index] = number;
        }
      }
      if (index % KEY_STEP === KEY_STEP - 1) {
        yield;
      }
    }
    const texts = [...ids.keys()];
    ids.clear();
    const byText = yield* mergeSortSteps(
      Array.from({ length: texts.length }, (_, id) => id),
      (left, right) => COLLATOR.compare(texts[left] ?? '', texts[right] ?? ''),
    );
    const rankOf = new Int32Array(texts.length);
    let rank = 0;
    for (let place = 0; place < byText.length; place++) {
      const id = byText[place] ?? 0;
      // Texts the collator holds equal (composed and decomposed accents) share a rank.
      if (
        place > 0 &&
        COLLATOR.compare(texts[byText[place - 1] ?? 0] ?? '', texts[id] ?? '') !== 0
      ) {
        rank++;
      }
      rankOf[id] = rank;
      if (place % KEY_STEP === KEY_STEP - 1) {
        yield;
      }
    }
    for (let index = 0; index < length; index++) {
      const id = textOf[index] ?? 0;
      if (id >= 0) {
        this.rank[index] = rankOf[id] ?? 0;
      }
    }
    return this;
  }

  /**
   * Orders two cells: NULL after everything, booleans false before true, exact
   * numbers digit by digit, other numbers as numbers and before any text, text by
   * the collator.
   */
  compare(left: number, right: number): number {
    const leftKind = this.kind[left] ?? 0;
    const rightKind = this.kind[right] ?? 0;
    if (leftKind === NULL || rightKind === NULL) {
      return Number(leftKind === NULL) - Number(rightKind === NULL);
    }
    if (leftKind === BOOLEAN || rightKind === BOOLEAN) {
      return (this.truth[left] ?? 0) - (this.truth[right] ?? 0);
    }
    const hasLeft = this.hasNumber[left] === 1;
    const hasRight = this.hasNumber[right] === 1;
    if (this.exact[left] === 1 && this.exact[right] === 1) {
      if (this.fits[left] === 1 && this.fits[right] === 1) {
        return this.compareNumbers(left, right);
      }
      return compareExact(this.digitsAt(left), this.digitsAt(right));
    }
    if (hasLeft && hasRight) {
      return this.compareNumbers(left, right);
    }
    // Numbers before text, so a mixed column still has a stable order.
    if (hasLeft) {
      return -1;
    }
    if (hasRight) {
      return 1;
    }
    return (this.rank[left] ?? 0) - (this.rank[right] ?? 0);
  }

  private compareNumbers(left: number, right: number): number {
    const leftNumber = this.numbers[left] ?? 0;
    const rightNumber = this.numbers[right] ?? 0;
    return leftNumber === rightNumber ? 0 : leftNumber < rightNumber ? -1 : 1;
  }

  /** Digits are worked out only for long numbers, and only once they are compared. */
  private digitsAt(index: number): ExactNumber {
    let digits = this.digits[index];
    if (digits === undefined) {
      digits = exactOf(cellText(this.valueAt(index) ?? null));
      this.digits[index] = digits;
    }
    return digits;
  }
}

/**
 * Orders two values of one column. Numbers compare as numbers, text as text, and
 * NULL always sorts after everything so an empty cell never hides a real value.
 */
export function compareCells(left: CellValue, right: CellValue): number {
  const keys = runSteps(new ColumnKeys((index) => (index === 0 ? left : right), 2).build());
  return keys.compare(0, 1);
}

function* sortSteps<T extends readonly CellValue[]>(
  rows: readonly T[],
  column: number,
  direction: SortDirection,
): Generator<void, T[], void> {
  const keys = yield* new ColumnKeys((index) => rows[index]?.[column], rows.length).build();
  const sign = direction === 'desc' ? -1 : 1;
  const order = yield* mergeSortSteps(
    Array.from({ length: rows.length }, (_, index) => index),
    (left, right) => {
      const leftNull = keys.kind[left] === NULL;
      // NULLs stay last in both directions: they are absence, not a value.
      if (leftNull !== (keys.kind[right] === NULL)) {
        return leftNull ? 1 : -1;
      }
      return keys.compare(left, right) * sign;
    },
  );
  const sorted: T[] = [];
  for (const index of order) {
    const row = rows[index];
    if (row !== undefined) {
      sorted.push(row);
    }
  }
  return sorted;
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
  return runSteps(sortSteps(rows, column, direction));
}

/**
 * The same order as `sortRows`, worked out in slices with pauses between them, so a
 * million rows never hold the thread for longer than one slice.
 */
export function sortRowsPaused<T extends readonly CellValue[]>(
  rows: readonly T[],
  column: number,
  direction: SortDirection,
  options?: PauseOptions,
): Promise<T[]> {
  return runStepsPaused(sortSteps(rows, column, direction), options);
}
