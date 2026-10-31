// The totals of the selected cells (V10.2.4): how many hold a value, and for numbers
// their sum, average, smallest and largest. Integers and decimals add up exactly, as
// scaled big integers — a column of `DECIMAL(20,2)` must not come out as 0.30000000004.

import { type CellValue, isTaggedValue } from './cell-value';

export interface CellSummary {
  /** Cells in the selection. */
  readonly cells: number;
  /** Cells that are not NULL. */
  readonly values: number;
  /** Cells that hold a number; the rest of the figures are about them. */
  readonly numbers: number;
  readonly sum?: string;
  readonly average?: string;
  readonly min?: string;
  readonly max?: string;
  /** A floating-point value was in the mix, so the figures are as exact as doubles. */
  readonly approximate?: true;
}

/** An exact number: `value / 10^scale`. */
interface Exact {
  readonly value: bigint;
  readonly scale: number;
}

/** Decimal places kept; a scale past this is a float in disguise. */
const MAX_SCALE = 40;

/** Extra decimal places an average gets beyond those of its numbers. */
const AVERAGE_PLACES = 6;

const PLAIN_DECIMAL = /^(-?)(\d+)(?:\.(\d+))?$/u;

function exactOf(text: string): Exact | undefined {
  const match = PLAIN_DECIMAL.exec(text);
  if (match === null) {
    return undefined;
  }
  const [, sign = '', whole = '', fraction = ''] = match;
  if (fraction.length > MAX_SCALE) {
    return undefined;
  }
  return { value: BigInt(`${sign}${whole}${fraction}`), scale: fraction.length };
}

/** The number a cell holds, exactly where possible; undefined for anything else. */
function numberOf(cell: CellValue): { exact?: Exact; approximate: number } | undefined {
  if (typeof cell === 'number') {
    if (!Number.isFinite(cell)) {
      return undefined;
    }
    const exact = Number.isSafeInteger(cell) ? { value: BigInt(cell), scale: 0 } : undefined;
    return exact === undefined ? { approximate: cell } : { exact, approximate: cell };
  }
  if (isTaggedValue(cell) && (cell.kind === 'bigint' || cell.kind === 'decimal')) {
    const exact = exactOf(cell.text);
    const approximate = Number(cell.text);
    if (!Number.isFinite(approximate)) {
      return undefined;
    }
    return exact === undefined ? { approximate } : { exact, approximate };
  }
  return undefined;
}

function rescale(number: Exact, scale: number): bigint {
  return number.value * 10n ** BigInt(scale - number.scale);
}

function add(a: Exact, b: Exact): Exact {
  const scale = Math.max(a.scale, b.scale);
  return { value: rescale(a, scale) + rescale(b, scale), scale };
}

function compare(a: Exact, b: Exact): number {
  const scale = Math.max(a.scale, b.scale);
  const left = rescale(a, scale);
  const right = rescale(b, scale);
  return left < right ? -1 : left > right ? 1 : 0;
}

/** `-12.50` from (-1250, 2): every decimal place kept, as the database writes them. */
export function exactText(number: Exact): string {
  const negative = number.value < 0n;
  const digits = (negative ? -number.value : number.value).toString();
  if (number.scale === 0) {
    return `${negative ? '-' : ''}${digits}`;
  }
  const padded = digits.padStart(number.scale + 1, '0');
  const whole = padded.slice(0, -number.scale);
  const fraction = padded.slice(-number.scale);
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}

/** The average, rounded half away from zero, without trailing zeros. */
function average(sum: Exact, count: number): string {
  const scale = sum.scale + AVERAGE_PLACES;
  const scaled = rescale(sum, scale);
  const divisor = BigInt(count);
  const half = divisor / 2n;
  const rounded = scaled < 0n ? (scaled - half) / divisor : (scaled + half) / divisor;
  const text = exactText({ value: rounded, scale });
  return text.includes('.') ? text.replace(/\.?0+$/u, '') : text;
}

/** Shortest text of a double; `0.1 + 0.2` shows what JavaScript holds, no more. */
function approximateText(number: number): string {
  return String(number);
}

/** Rows looked at between two yields. */
const SUMMARY_STEP = 1024;

/**
 * Sums up the cells of `columns` in rows `top`..`bottom`, reading rows a batch at a time
 * through `read` (which returns fewer rows at the end). Yields between batches, so a
 * caller can pause; undefined when `read` says the rows are gone.
 */
export function* summarySteps(
  read: (offset: number, count: number) => readonly (readonly CellValue[])[] | undefined,
  top: number,
  bottom: number,
  columns: readonly number[],
): Generator<void, CellSummary | undefined, void> {
  let cells = 0;
  let values = 0;
  let numbers = 0;
  let exactSum: Exact | undefined = { value: 0n, scale: 0 };
  let approximateSum = 0;
  let inexact = false;
  let min: { exact?: Exact; approximate: number } | undefined;
  let max: { exact?: Exact; approximate: number } | undefined;
  for (let offset = top; offset <= bottom; offset += SUMMARY_STEP) {
    const rows = read(offset, Math.min(SUMMARY_STEP, bottom - offset + 1));
    if (rows === undefined) {
      return undefined;
    }
    for (const row of rows) {
      for (const column of columns) {
        cells++;
        const cell = row[column] ?? null;
        if (cell === null) {
          continue;
        }
        values++;
        const number = numberOf(cell);
        if (number === undefined) {
          continue;
        }
        numbers++;
        approximateSum += number.approximate;
        if (number.exact === undefined) {
          inexact = true;
        } else if (exactSum !== undefined) {
          exactSum = add(exactSum, number.exact);
          if (exactSum.scale > MAX_SCALE) {
            exactSum = undefined;
          }
        }
        const smaller =
          min === undefined ||
          (number.exact !== undefined && min.exact !== undefined
            ? compare(number.exact, min.exact) < 0
            : number.approximate < min.approximate);
        if (smaller) {
          min = number;
        }
        const larger =
          max === undefined ||
          (number.exact !== undefined && max.exact !== undefined
            ? compare(number.exact, max.exact) > 0
            : number.approximate > max.approximate);
        if (larger) {
          max = number;
        }
      }
    }
    if (rows.length < Math.min(SUMMARY_STEP, bottom - offset + 1)) {
      break;
    }
    yield;
  }
  const base = { cells, values, numbers };
  if (numbers === 0 || min === undefined || max === undefined) {
    return base;
  }
  const textOf = (number: { exact?: Exact; approximate: number }): string =>
    number.exact === undefined ? approximateText(number.approximate) : exactText(number.exact);
  if (inexact || exactSum === undefined) {
    return {
      ...base,
      sum: approximateText(approximateSum),
      average: approximateText(approximateSum / numbers),
      min: textOf(min),
      max: textOf(max),
      approximate: true,
    };
  }
  return {
    ...base,
    sum: exactText(exactSum),
    average: average(exactSum, numbers),
    min: textOf(min),
    max: textOf(max),
  };
}
