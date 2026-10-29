// Turning what a user types into a cell back into a CellValue, by the type of the
// column. The host is the authority (it runs this before queuing a change); the page
// uses the same code to pick an editor and to check input as the user types.

import { clickhouseBareType } from './clickhouse-types';
import { type CellValue } from './cell-value';
import type { DriverId } from './connection';

export const INPUT_KINDS = [
  'text',
  'integer',
  'number',
  'boolean',
  'date',
  'time',
  'datetime',
  'enum',
  'json',
  'binary',
] as const;

export type InputKind = (typeof INPUT_KINDS)[number];

/** Kinds the grid cannot edit as text yet; binary arrives with the value panel (V2.5). */
export function isTextEditable(kind: InputKind): boolean {
  return kind !== 'binary';
}

/**
 * Which editor a column of this database type gets. The driver matters only where a
 * type name means something else there: Oracle's DATE holds a time of day too.
 */
export function inputKindOf(dataType: string | undefined, driver?: DriverId): InputKind {
  // ClickHouse wraps the type it stores: Nullable(…), LowCardinality(…).
  const type = clickhouseBareType(dataType ?? '').toLowerCase();
  if (type === '') {
    return 'text';
  }
  if (/^enum(8|16)?\s*\(/u.test(type)) {
    return 'enum';
  }
  if (/blob|binary|bytea|^raw\b|^image$/u.test(type)) {
    return 'binary';
  }
  if (/^jsonb?$/u.test(type)) {
    return 'json';
  }
  // SQL Server's BIT is its boolean; MySQL's always says its width, `bit(8)`.
  if (/^bool(ean)?$|^bit$/u.test(type)) {
    return 'boolean';
  }
  if (/^(timestamp|datetime|smalldatetime)/u.test(type)) {
    return 'datetime';
  }
  if (/^date(32)?$/u.test(type)) {
    return driver === 'oracle' ? 'datetime' : 'date';
  }
  if (/^time(\s|\(|$)/u.test(type)) {
    return 'time';
  }
  if (
    /^(tiny|small|medium|big)?int(eger)?\d*(\s|\(|$)|^(big|small)?serial\d*$|^year|^uint\d+$/u.test(
      type,
    )
  ) {
    return 'integer';
  }
  if (
    /^(decimal|numeric|dec|fixed|float\d*|double|real|(small)?money|number)(\s|\(|$)/u.test(type)
  ) {
    return 'number';
  }
  return 'text';
}

/**
 * The values of `enum('a','b')` (and ClickHouse's `Enum8('a' = 1, 'b' = 2)`), or undefined
 * when the type does not list them.
 */
export function enumOptions(dataType: string | undefined): string[] | undefined {
  const match = /^enum(?:8|16)?\s*\((.*)\)$/isu.exec(clickhouseBareType(dataType ?? ''));
  if (match === null) {
    return undefined;
  }
  const options: string[] = [];
  const body = match[1] ?? '';
  const pattern = /'((?:[^']|'')*)'/gu;
  for (let found = pattern.exec(body); found !== null; found = pattern.exec(body)) {
    options.push((found[1] ?? '').replaceAll("''", "'"));
  }
  return options;
}

/** What the user did to a cell: typed a value, or asked for NULL or the default. */
export type EditInput =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'null' }
  | { readonly kind: 'default' };

export type InputProblem =
  | 'invalid-integer'
  | 'invalid-number'
  | 'invalid-boolean'
  | 'invalid-date'
  | 'invalid-time'
  | 'invalid-datetime'
  | 'invalid-json'
  | 'invalid-enum'
  | 'unsupported';

export type ParsedInput =
  | { readonly ok: true; readonly value: CellValue }
  | { readonly ok: false; readonly problem: InputProblem };

const ZONE = '(?:Z|[+-]\\d{2}(?::?\\d{2})?)?';
/** Oracle and SQL Server print the zone after a space: `… 12:00:00.1234567 +03:00`. */
const SPACED_ZONE = / (?=Z$|[+-]\d{2}(?::?\d{2})?$)/u;
const INTEGER = /^[+-]?\d+$/u;
const NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
const TIME = new RegExp(`^-?\\d{1,3}:[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,6})?)?${ZONE}$`, 'u');
const DATETIME = new RegExp(
  `^(\\d{4})-(\\d{2})-(\\d{2})[ T](\\d{2}):[0-5]\\d(?::[0-5]\\d(?:\\.\\d{1,9})?)? ?${ZONE}$`,
  'u',
);

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) {
    return false;
  }
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1] ?? 0;
  return day <= days;
}

const TRUE_WORDS = new Set(['true', 't', '1', 'yes', 'y', 'on']);
const FALSE_WORDS = new Set(['false', 'f', '0', 'no', 'n', 'off']);

/** Reads typed text as a value of the given kind. Never throws. */
export function parseCellInput(
  kind: InputKind,
  input: string,
  options?: readonly string[],
): ParsedInput {
  switch (kind) {
    case 'text':
      return { ok: true, value: input };
    case 'binary':
      return { ok: false, problem: 'unsupported' };
    case 'enum':
      return options !== undefined && !options.includes(input)
        ? { ok: false, problem: 'invalid-enum' }
        : { ok: true, value: input };
    case 'integer': {
      const text = input.trim();
      if (!INTEGER.test(text)) {
        return { ok: false, problem: 'invalid-integer' };
      }
      const normalized = text.replace(/^\+/u, '').replace(/^(-?)0+(?=\d)/u, '$1');
      const asNumber = Number(normalized);
      return {
        ok: true,
        value: Number.isSafeInteger(asNumber) ? asNumber : { kind: 'bigint', text: normalized },
      };
    }
    case 'number': {
      const text = input.trim();
      if (!NUMBER.test(text)) {
        return { ok: false, problem: 'invalid-number' };
      }
      const asNumber = Number(text);
      // A number that survives the trip through a double is a plain number; anything
      // else (long decimals, huge exponents) stays text so no digit is lost.
      return {
        ok: true,
        value:
          Number.isFinite(asNumber) && String(asNumber) === text
            ? asNumber
            : { kind: 'decimal', text },
      };
    }
    case 'boolean': {
      const word = input.trim().toLowerCase();
      if (TRUE_WORDS.has(word)) {
        return { ok: true, value: true };
      }
      return FALSE_WORDS.has(word)
        ? { ok: true, value: false }
        : { ok: false, problem: 'invalid-boolean' };
    }
    case 'date': {
      const match = DATE.exec(input.trim());
      if (match === null || !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3]))) {
        return { ok: false, problem: 'invalid-date' };
      }
      return { ok: true, value: { kind: 'datetime', text: input.trim() } };
    }
    case 'time': {
      const text = input.trim();
      return TIME.test(text)
        ? { ok: true, value: { kind: 'datetime', text } }
        : { ok: false, problem: 'invalid-time' };
    }
    case 'datetime': {
      const text = input.trim();
      const match = DATETIME.exec(text);
      const hour = Number(match?.[4]);
      if (
        match === null ||
        !isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])) ||
        hour > 23
      ) {
        return { ok: false, problem: 'invalid-datetime' };
      }
      // `T` is the browser's spelling; databases take the space. The zone goes right
      // after the time, which every server reads.
      return {
        ok: true,
        value: { kind: 'datetime', text: text.replace('T', ' ').replace(SPACED_ZONE, '') },
      };
    }
    case 'json':
      try {
        JSON.parse(input);
        return { ok: true, value: { kind: 'json', text: input } };
      } catch {
        return { ok: false, problem: 'invalid-json' };
      }
  }
}
