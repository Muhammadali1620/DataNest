// Filling a block of selected cells (V12.6): one value for all of them, the top cell copied
// down, or a series — numbers or dates stepping from a start. Pure text arithmetic: the
// host turns each text into an ordinary cell edit, so the column's own type decides whether
// it is accepted. Numbers are counted in scaled integers, so 0.1 + 0.2 stays 0.3.

import type { EditInput } from './cell-input';

/** Most cells one fill may touch; a larger selection is refused rather than queued. */
export const MAX_FILL_CELLS = 100_000;

export const DATE_UNITS = ['day', 'week', 'month', 'year'] as const;
export type DateUnit = (typeof DATE_UNITS)[number];

export type FillSpec =
  /** The same input in every selected cell. */
  | { readonly kind: 'value'; readonly input: EditInput }
  /** The top cell of the selection, copied into the cells under it, column by column. */
  | { readonly kind: 'down' }
  /** `start`, `start + step`, … in every column; `{n}` in `template` stands for the number. */
  | {
      readonly kind: 'series';
      readonly start: string;
      readonly step: string;
      readonly template?: string;
      /** Least digits before the decimal point; shorter numbers get leading zeros. */
      readonly pad?: number;
    }
  /** Dates (or date-times) from `start`, `step` units apart. */
  | {
      readonly kind: 'dates';
      readonly start: string;
      readonly step: number;
      readonly unit: DateUnit;
    };

export type SeriesSpec = Extract<FillSpec, { kind: 'series' | 'dates' }>;

/** Why a fill spec cannot produce values. */
export const FILL_PROBLEMS = [
  'invalid-start',
  'invalid-step',
  'invalid-template',
  'invalid-start-date',
  'too-many-cells',
] as const;
export type FillProblem = (typeof FILL_PROBLEMS)[number];

export type SeriesResult =
  | { readonly ok: true; readonly texts: string[] }
  | { readonly ok: false; readonly problem: FillProblem };

const DECIMAL = /^([+-]?)(\d+)(?:\.(\d+))?$/u;
const MAX_PAD = 40;
const MAX_DIGITS = 30;

interface Scaled {
  readonly value: bigint;
  readonly scale: number;
}

function parseDecimal(text: string): Scaled | undefined {
  const match = DECIMAL.exec(text.trim());
  if (match === null) {
    return undefined;
  }
  const [, sign = '', whole = '', fraction = ''] = match;
  if (whole.length + fraction.length > MAX_DIGITS) {
    return undefined;
  }
  const magnitude = BigInt(`${whole}${fraction}`);
  return { value: sign === '-' ? -magnitude : magnitude, scale: fraction.length };
}

function formatScaled(value: bigint, scale: number, pad: number): string {
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString().padStart(scale + 1, '0');
  const whole = digits.slice(0, digits.length - scale).padStart(pad, '0');
  const fraction = scale === 0 ? '' : `.${digits.slice(digits.length - scale)}`;
  return `${negative ? '-' : ''}${whole}${fraction}`;
}

/** `count` numbers from `start` with `step`, each placed into the template. */
function numberSeries(spec: Extract<SeriesSpec, { kind: 'series' }>, count: number): SeriesResult {
  const start = parseDecimal(spec.start);
  if (start === undefined) {
    return { ok: false, problem: 'invalid-start' };
  }
  const step = parseDecimal(spec.step);
  if (step === undefined) {
    return { ok: false, problem: 'invalid-step' };
  }
  const template = spec.template ?? '{n}';
  if (!template.includes('{n}')) {
    return { ok: false, problem: 'invalid-template' };
  }
  const pad = Math.max(0, Math.min(MAX_PAD, Math.trunc(spec.pad ?? 0)));
  const scale = Math.max(start.scale, step.scale);
  const from = start.value * 10n ** BigInt(scale - start.scale);
  const by = step.value * 10n ** BigInt(scale - step.scale);
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const number = formatScaled(from + by * BigInt(index), scale, pad);
    texts.push(template.split('{n}').join(number));
  }
  return { ok: true, texts };
}

const DATE_START = /^(\d{4})-(\d{2})-(\d{2})((?:[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?)$/u;

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function two(value: number): string {
  return String(value).padStart(2, '0');
}

/** `count` dates from `start`; the time of day, if the start has one, stays as typed. */
function dateSeries(spec: Extract<SeriesSpec, { kind: 'dates' }>, count: number): SeriesResult {
  const match = DATE_START.exec(spec.start.trim());
  if (match === null || !Number.isInteger(spec.step) || !DATE_UNITS.includes(spec.unit)) {
    return { ok: false, problem: match === null ? 'invalid-start-date' : 'invalid-step' };
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const time = match[4] ?? '';
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    return { ok: false, problem: 'invalid-start-date' };
  }
  const texts: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const steps = index * spec.step;
    let y: number;
    let m: number;
    let d: number;
    if (spec.unit === 'day' || spec.unit === 'week') {
      const moved = new Date(
        Date.UTC(year, month - 1, day + steps * (spec.unit === 'week' ? 7 : 1)),
      );
      y = moved.getUTCFullYear();
      m = moved.getUTCMonth() + 1;
      d = moved.getUTCDate();
    } else {
      const months = (spec.unit === 'year' ? 12 : 1) * steps;
      const total = year * 12 + (month - 1) + months;
      y = Math.floor(total / 12);
      m = (((total % 12) + 12) % 12) + 1;
      d = Math.min(day, daysInMonth(y, m));
    }
    if (y < 1 || y > 9999) {
      return { ok: false, problem: 'invalid-step' };
    }
    texts.push(`${String(y).padStart(4, '0')}-${two(m)}-${two(d)}${time}`);
  }
  return { ok: true, texts };
}

/** The texts a series puts into `count` cells one under another. */
export function seriesTexts(spec: SeriesSpec, count: number): SeriesResult {
  if (count > MAX_FILL_CELLS) {
    return { ok: false, problem: 'too-many-cells' };
  }
  return spec.kind === 'series' ? numberSeries(spec, count) : dateSeries(spec, count);
}
