// Exact dates from Oracle (D24). node-oracledb's thin driver turns DATE and TIMESTAMP into
// JS Dates in the local time zone, losing every digit past the millisecond and the offset
// of TIMESTAMP WITH TIME ZONE; asked for text, it prints such a Date. Its protocol reads
// column dates through one method of its buffer class, so that method is replaced once:
// the bytes become the date, time, fraction and offset the server stored.

// A plain require, not an import: the method has to be replaced on the very class the
// driver's own modules use, which an import namespace does not allow.
// eslint-disable-next-line @typescript-eslint/no-require-imports
import bufferModule = require('oracledb/lib/impl/datahandlers/buffer');

/** A date or timestamp in its parts; the session formats it by the column's precision. */
export class OracleDateText {
  constructor(
    /** `2024-02-29`. */
    readonly date: string,
    /** `23:59:59`. */
    readonly time: string,
    /** Nanoseconds past the second. */
    readonly nanos: number,
    /** Minutes east of UTC, for TIMESTAMP WITH TIME ZONE; null for a named region. */
    readonly offsetMinutes: number | null | undefined,
  ) {}

  /** As Oracle prints it: fraction digits by the column's precision, then the offset. */
  format(fractionDigits: number): string {
    const fraction =
      fractionDigits > 0 ? `.${String(this.nanos).padStart(9, '0').slice(0, fractionDigits)}` : '';
    const zone =
      this.offsetMinutes === undefined
        ? ''
        : this.offsetMinutes === null
          ? ' UTC'
          : ` ${offsetText(this.offsetMinutes)}`;
    return `${this.date} ${this.time}${fraction}${zone}`;
  }
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const whole = Math.abs(minutes);
  return `${sign}${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** Days in a month of the proleptic Gregorian calendar, for carrying an offset over. */
function daysIn(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return month === 2 && leap ? 29 : (MONTH_DAYS[month - 1] ?? 31);
}

/**
 * The 7 bytes of a DATE (century and year +100, month, day, hour, minute and second +1),
 * 11 of a TIMESTAMP (+ nanoseconds), or 13 of one WITH TIME ZONE (+ offset hours +20
 * and minutes +60, or a region id). Zoned values are stored in UTC.
 */
export function decodeOracleDate(buf: Uint8Array): OracleDateText {
  let year = ((buf[0] ?? 100) - 100) * 100 + ((buf[1] ?? 100) - 100);
  let month = buf[2] ?? 1;
  let day = buf[3] ?? 1;
  let hour = (buf[4] ?? 1) - 1;
  let minute = (buf[5] ?? 1) - 1;
  const second = (buf[6] ?? 1) - 1;
  const nanos =
    buf.length >= 11
      ? (((buf[7] ?? 0) << 24) >>> 0) +
        ((buf[8] ?? 0) << 16) +
        ((buf[9] ?? 0) << 8) +
        (buf[10] ?? 0)
      : 0;
  let offsetMinutes: number | null | undefined;
  if (buf.length >= 13) {
    const hourByte = buf[11] ?? 20;
    if ((hourByte & 0x80) !== 0) {
      // A named region (Europe/Berlin): its offset needs the server's zone tables.
      offsetMinutes = null;
    } else {
      offsetMinutes = (hourByte - 20) * 60 + ((buf[12] ?? 60) - 60);
      // Shown in its own zone, as the server shows it.
      let total = hour * 60 + minute + offsetMinutes;
      while (total < 0) {
        total += 24 * 60;
        day -= 1;
        if (day < 1) {
          month -= 1;
          if (month < 1) {
            month = 12;
            year -= 1;
          }
          day = daysIn(year, month);
        }
      }
      while (total >= 24 * 60) {
        total -= 24 * 60;
        day += 1;
        if (day > daysIn(year, month)) {
          day = 1;
          month += 1;
          if (month > 12) {
            month = 1;
            year += 1;
          }
        }
      }
      hour = Math.floor(total / 60);
      minute = total % 60;
    }
  }
  const yearText = year < 0 ? `-${pad(-year, 4)}` : pad(year, 4);
  return new OracleDateText(
    `${yearText}-${pad(month)}-${pad(day)}`,
    `${pad(hour)}:${pad(minute)}:${pad(second)}`,
    nanos,
    offsetMinutes,
  );
}

interface ReadingBuffer {
  readBytesWithLength(): Uint8Array | null | undefined;
}

let installed = false;

/** Replaces how the thin driver reads column dates; safe to call more than once. */
export function installExactDates(): void {
  if (installed) {
    return;
  }
  installed = true;
  const prototype = bufferModule.BaseBuffer.prototype;
  prototype.readOracleDate = function readOracleDate(this: ReadingBuffer): OracleDateText | null {
    const bytes = this.readBytesWithLength();
    return bytes === null || bytes === undefined ? null : decodeOracleDate(bytes);
  };
}
