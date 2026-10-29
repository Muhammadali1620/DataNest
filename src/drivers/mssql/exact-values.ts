// Exact values from SQL Server (D24). tedious turns DECIMAL and MONEY into JS numbers,
// losing digits past the 15th, and dates into JS Dates, losing the time zone offset and
// every digit past the millisecond. Its row parser looks `readValue` up on the module at
// each call, so wrapping it once is enough: these types are decoded here from the TDS
// bytes into the text the server itself would print, everything else is left to tedious.

// Plain requires, not imports: the wrapper has to replace a property of the very
// object tedious' own modules read from, which an import namespace does not allow.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import valueParser = require('tedious/lib/value-parser');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import helpers = require('tedious/lib/token/helpers');

/** A value read from the bytes, as the server's text; the session tags it. */
export class ExactText {
  constructor(
    readonly kind: 'decimal' | 'datetime',
    readonly text: string,
  ) {}
}

/** The slice of tedious' column metadata the decoders need. */
export interface ValueMetadata {
  readonly type: { readonly name: string };
  readonly scale?: number | undefined;
}

interface Decoded {
  readonly value: ExactText | null;
  readonly offset: number;
}

type ReadValue = typeof valueParser.readValue;

let installed = false;

/** Wraps tedious' value reader; safe to call more than once. */
export function installExactValues(): void {
  if (installed) {
    return;
  }
  installed = true;
  const original: ReadValue = valueParser.readValue;
  const wrapped: ReadValue = (buf, offset, metadata, options) => {
    const decoded = decodeExact(buf, offset, metadata);
    return decoded === undefined
      ? original(buf, offset, metadata, options)
      : new helpers.Result(decoded.value, decoded.offset);
  };
  (valueParser as { readValue: ReadValue }).readValue = wrapped;
}

/**
 * Decodes one value of an exact type at `offset`, or undefined for any other type.
 * Throws tedious' NotEnoughDataError when the value is not all there yet, which makes
 * the parser wait for the next packet and try again.
 */
export function decodeExact(
  buf: Buffer,
  offset: number,
  metadata: ValueMetadata,
): Decoded | undefined {
  const scale = metadata.scale ?? 7;
  switch (metadata.type.name) {
    case 'NumericN':
    case 'DecimalN':
      return sized(buf, offset, 'decimal', (start, length) =>
        decimalText(buf, start, length, scale),
      );
    case 'Money':
      return fixed(buf, offset, 8, 'decimal', (start) => moneyText(buf, start, 8));
    case 'SmallMoney':
      return fixed(buf, offset, 4, 'decimal', (start) => moneyText(buf, start, 4));
    case 'MoneyN':
      return sized(buf, offset, 'decimal', (start, length) => moneyText(buf, start, length));
    case 'DateTime':
      return fixed(buf, offset, 8, 'datetime', (start) => legacyDateTimeText(buf, start, 8));
    case 'SmallDateTime':
      return fixed(buf, offset, 4, 'datetime', (start) => legacyDateTimeText(buf, start, 4));
    case 'DateTimeN':
      return sized(buf, offset, 'datetime', (start, length) =>
        legacyDateTimeText(buf, start, length),
      );
    case 'Date':
      return sized(buf, offset, 'datetime', (start) => dateText(readUInt(buf, start, 3)));
    case 'Time':
      return sized(buf, offset, 'datetime', (start, length) =>
        timeText(readUInt(buf, start, length), scale),
      );
    case 'DateTime2':
      return sized(buf, offset, 'datetime', (start, length) => {
        const time = readUInt(buf, start, length - 3);
        return `${dateText(readUInt(buf, start + length - 3, 3))} ${timeText(time, scale)}`;
      });
    case 'DateTimeOffset':
      return sized(buf, offset, 'datetime', (start, length) =>
        dateTimeOffsetText(buf, start, length, scale),
      );
    default:
      return undefined;
  }
}

function need(buf: Buffer, end: number): void {
  if (buf.length < end) {
    // tedious' own signal for "wait for the next packet": not an Error on purpose
    // (no stack to capture), and its parser catches exactly this class.
    // eslint-disable-next-line @typescript-eslint/only-throw-error
    throw new helpers.NotEnoughDataError(end);
  }
}

/** A value of a fixed number of bytes, never NULL (NOT NULL columns). */
function fixed(
  buf: Buffer,
  offset: number,
  length: number,
  kind: ExactText['kind'],
  text: (start: number) => string,
): Decoded {
  need(buf, offset + length);
  return { value: new ExactText(kind, text(offset)), offset: offset + length };
}

/** A value after a one-byte length, where 0 means NULL. */
function sized(
  buf: Buffer,
  offset: number,
  kind: ExactText['kind'],
  text: (start: number, length: number) => string,
): Decoded {
  need(buf, offset + 1);
  const length = buf.readUInt8(offset);
  if (length === 0) {
    return { value: null, offset: offset + 1 };
  }
  need(buf, offset + 1 + length);
  return { value: new ExactText(kind, text(offset + 1, length)), offset: offset + 1 + length };
}

function readUInt(buf: Buffer, start: number, length: number): number {
  let value = 0;
  for (let index = length - 1; index >= 0; index--) {
    value = value * 256 + (buf[start + index] ?? 0);
  }
  return value;
}

function readUBigInt(buf: Buffer, start: number, length: number): bigint {
  let value = 0n;
  for (let index = length - 1; index >= 0; index--) {
    value = value * 256n + BigInt(buf[start + index] ?? 0);
  }
  return value;
}

/** `digits` divided by 10^scale, with every scale digit kept: `-12.50`. */
export function scaledText(negative: boolean, digits: bigint, scale: number): string {
  let text = digits.toString().padStart(scale + 1, '0');
  if (scale > 0) {
    text = `${text.slice(0, -scale)}.${text.slice(-scale)}`;
  }
  return negative && digits !== 0n ? `-${text}` : text;
}

/** A sign byte (1 is positive) and the magnitude, little-endian. */
function decimalText(buf: Buffer, start: number, length: number, scale: number): string {
  const negative = buf.readUInt8(start) !== 1;
  return scaledText(negative, readUBigInt(buf, start + 1, length - 1), scale);
}

/** MONEY: the high 32 bits first, then the low ones; SMALLMONEY: one int32. Both ×10⁴. */
function moneyText(buf: Buffer, start: number, length: number): string {
  const value =
    length === 4
      ? BigInt(buf.readInt32LE(start))
      : (BigInt(buf.readInt32LE(start)) << 32n) + BigInt(buf.readUInt32LE(start + 4));
  return scaledText(value < 0n, value < 0n ? -value : value, 4);
}

const DAY_MS = 86_400_000;
/** 0001-01-01 and 1900-01-01 as days before 1970-01-01. */
const DAYS_TO_EPOCH_FROM_0001 = 719_162;
const DAYS_TO_EPOCH_FROM_1900 = 25_567;

/** The proleptic Gregorian date of a day number counted from 1970-01-01. */
export function civilDate(epochDays: number): string {
  // Howard Hinnant's days-to-civil algorithm: integer math only, no Date pitfalls
  // with the years 1 to 99.
  const z = epochDays + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor(
    (doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365,
  );
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const day = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const month = mp < 10 ? mp + 3 : mp - 9;
  const year = yoe + era * 400 + (month <= 2 ? 1 : 0);
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}`;
}

/** DATE: days since 0001-01-01. */
function dateText(days: number): string {
  return civilDate(days - DAYS_TO_EPOCH_FROM_0001);
}

/** TIME(n): units of 10^-n seconds since midnight, all n fraction digits shown. */
export function timeText(ticks: number, scale: number): string {
  const unit = 10 ** scale;
  const seconds = Math.floor(ticks / unit);
  const fraction = ticks - seconds * unit;
  const clock = `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
  return scale === 0 ? clock : `${clock}.${String(fraction).padStart(scale, '0')}`;
}

/** DATETIMEOFFSET: UTC time and date, then the offset in minutes; shown in local time. */
function dateTimeOffsetText(buf: Buffer, start: number, length: number, scale: number): string {
  const timeLength = length - 5;
  const unit = 10 ** scale;
  const dayTicks = 86_400 * unit;
  const offsetMinutes = buf.readInt16LE(start + length - 2);
  let days = readUInt(buf, start + timeLength, 3);
  let ticks = readUInt(buf, start, timeLength) + offsetMinutes * 60 * unit;
  if (ticks < 0) {
    ticks += dayTicks;
    days -= 1;
  } else if (ticks >= dayTicks) {
    ticks -= dayTicks;
    days += 1;
  }
  const sign = offsetMinutes < 0 ? '-' : '+';
  const minutes = Math.abs(offsetMinutes);
  return `${dateText(days)} ${timeText(ticks, scale)} ${sign}${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/**
 * DATETIME: days since 1900-01-01 and 1/300 s ticks, shown to the millisecond the way
 * the server rounds them (.000, .003, .007). SMALLDATETIME: days and minutes.
 */
function legacyDateTimeText(buf: Buffer, start: number, length: number): string {
  if (length === 4) {
    const days = buf.readUInt16LE(start);
    const minutes = buf.readUInt16LE(start + 2);
    return `${civilDate(days - DAYS_TO_EPOCH_FROM_1900)} ${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}:00`;
  }
  const days = buf.readInt32LE(start);
  const ms = Math.round((buf.readUInt32LE(start + 4) * 10) / 3);
  const seconds = Math.floor(ms / 1000);
  // 23:59:59.998 rounds to the next day's midnight in the server, and here too.
  const carry = ms >= DAY_MS ? 1 : 0;
  const clock =
    carry === 1 ? '00:00:00.000' : `${timeText(seconds, 0)}.${String(ms % 1000).padStart(3, '0')}`;
  return `${civilDate(days - DAYS_TO_EPOCH_FROM_1900 + carry)} ${clock}`;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}
