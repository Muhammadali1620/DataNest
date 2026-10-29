import { describe, expect, it } from 'vitest';
import { BaseBuffer } from 'oracledb/lib/impl/datahandlers/buffer';
import {
  decodeOracleDate,
  installExactDates,
  OracleDateText,
} from '../../../../src/drivers/oracle/exact-dates';

interface Moment {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour?: number;
  readonly minute?: number;
  readonly second?: number;
}

/** The 7 bytes of a DATE, as the server sends them. */
function dateBytes({ year, month, day, hour = 0, minute = 0, second = 0 }: Moment): number[] {
  const century = Math.trunc(year / 100);
  const rest = year - century * 100;
  return [century + 100, rest + 100, month, day, hour + 1, minute + 1, second + 1];
}

/** The 11 bytes of a TIMESTAMP: the DATE, then nanoseconds big-endian. */
function timestampBytes(moment: Moment, nanos: number): number[] {
  return [
    ...dateBytes(moment),
    (nanos >>> 24) & 0xff,
    (nanos >>> 16) & 0xff,
    (nanos >>> 8) & 0xff,
    nanos & 0xff,
  ];
}

/** The 13 bytes of a TIMESTAMP WITH TIME ZONE, stored in UTC, with its offset. */
function zonedBytes(utc: Moment, offsetHours: number, offsetMinutes = 0, nanos = 0): Uint8Array {
  return Uint8Array.from([...timestampBytes(utc, nanos), offsetHours + 20, offsetMinutes + 60]);
}

const shown = (bytes: Uint8Array | number[], digits = 0): string =>
  decodeOracleDate(Uint8Array.from(bytes)).format(digits);

describe('decodeOracleDate', () => {
  it('reads the 7 bytes of a DATE', () => {
    const value = decodeOracleDate(
      Uint8Array.from(
        dateBytes({ year: 2024, month: 2, day: 29, hour: 23, minute: 59, second: 58 }),
      ),
    );
    expect(value).toBeInstanceOf(OracleDateText);
    expect(value).toMatchObject({
      date: '2024-02-29',
      time: '23:59:58',
      nanos: 0,
      offsetMinutes: undefined,
    });
  });

  it('pads small years and parts with zeros', () => {
    expect(shown(dateBytes({ year: 1, month: 1, day: 1 }))).toBe('0001-01-01 00:00:00');
    expect(shown(dateBytes({ year: 999, month: 9, day: 9, hour: 9, minute: 9, second: 9 }))).toBe(
      '0999-09-09 09:09:09',
    );
    expect(
      shown(dateBytes({ year: 9999, month: 12, day: 31, hour: 23, minute: 59, second: 59 })),
    ).toBe('9999-12-31 23:59:59');
  });

  it('reads years before Christ as negative years', () => {
    // Oracle stores -4712 as century 53 and year 88: (53 - 100) * 100 + (88 - 100).
    expect(shown([53, 88, 1, 1, 1, 1, 1])).toBe('-4712-01-01 00:00:00');
    expect(shown(dateBytes({ year: -44, month: 3, day: 15, hour: 12 }))).toBe(
      '-0044-03-15 12:00:00',
    );
  });

  it('reads the nanoseconds of a TIMESTAMP', () => {
    const value = decodeOracleDate(
      Uint8Array.from(timestampBytes({ year: 2024, month: 5, day: 6, hour: 7 }, 123_456_789)),
    );
    expect(value.nanos).toBe(123_456_789);
    expect(value.offsetMinutes).toBeUndefined();
    expect(value.format(9)).toBe('2024-05-06 07:00:00.123456789');
  });

  it('reads the largest nanoseconds without a negative sign from the top byte', () => {
    expect(
      decodeOracleDate(
        Uint8Array.from(timestampBytes({ year: 2000, month: 1, day: 1 }, 999_999_999)),
      ).nanos,
    ).toBe(999_999_999);
    const top = Uint8Array.from([...dateBytes({ year: 2000, month: 1, day: 1 }), 0xff, 0, 0, 0]);
    expect(decodeOracleDate(top).nanos).toBe(0xff000000);
  });

  it('shows a zoned timestamp in its own zone', () => {
    const value = decodeOracleDate(
      zonedBytes({ year: 2024, month: 6, day: 1, hour: 7, minute: 15 }, 3, 0, 500_000_000),
    );
    expect(value).toMatchObject({ date: '2024-06-01', time: '10:15:00', offsetMinutes: 180 });
    expect(value.format(3)).toBe('2024-06-01 10:15:00.500 +03:00');
  });

  it('keeps a zero offset as +00:00', () => {
    expect(shown(zonedBytes({ year: 2024, month: 6, day: 1, hour: 7 }, 0))).toBe(
      '2024-06-01 07:00:00 +00:00',
    );
  });

  it('reads offsets with minutes, east and west', () => {
    expect(shown(zonedBytes({ year: 2024, month: 6, day: 1, hour: 7 }, 5, 30))).toBe(
      '2024-06-01 12:30:00 +05:30',
    );
    const west = decodeOracleDate(zonedBytes({ year: 2024, month: 6, day: 1, hour: 7 }, -3, -30));
    expect(west.offsetMinutes).toBe(-210);
    expect(west.format(0)).toBe('2024-06-01 03:30:00 -03:30');
  });

  it('carries an eastern offset into the next day, month and year', () => {
    expect(shown(zonedBytes({ year: 2024, month: 6, day: 1, hour: 22 }, 3))).toBe(
      '2024-06-02 01:00:00 +03:00',
    );
    expect(shown(zonedBytes({ year: 2024, month: 4, day: 30, hour: 22 }, 3))).toBe(
      '2024-05-01 01:00:00 +03:00',
    );
    expect(shown(zonedBytes({ year: 2024, month: 12, day: 31, hour: 23, minute: 30 }, 1))).toBe(
      '2025-01-01 00:30:00 +01:00',
    );
    expect(shown(zonedBytes({ year: 2024, month: 12, day: 31, hour: 12 }, 14))).toBe(
      '2025-01-01 02:00:00 +14:00',
    );
  });

  it('carries a western offset back into the day, month and year before', () => {
    expect(shown(zonedBytes({ year: 2024, month: 6, day: 2, hour: 1 }, -3))).toBe(
      '2024-06-01 22:00:00 -03:00',
    );
    expect(shown(zonedBytes({ year: 2024, month: 5, day: 1, hour: 1 }, -3))).toBe(
      '2024-04-30 22:00:00 -03:00',
    );
    expect(shown(zonedBytes({ year: 2024, month: 1, day: 1, minute: 30 }, -1))).toBe(
      '2023-12-31 23:30:00 -01:00',
    );
    expect(shown(zonedBytes({ year: 2024, month: 8, day: 1, hour: 2 }, -12))).toBe(
      '2024-07-31 14:00:00 -12:00',
    );
  });

  it('knows February of leap years when carrying over', () => {
    expect(shown(zonedBytes({ year: 2024, month: 2, day: 28, hour: 23 }, 2))).toBe(
      '2024-02-29 01:00:00 +02:00',
    );
    expect(shown(zonedBytes({ year: 2023, month: 2, day: 28, hour: 23 }, 2))).toBe(
      '2023-03-01 01:00:00 +02:00',
    );
    expect(shown(zonedBytes({ year: 2024, month: 3, day: 1, hour: 1 }, -5))).toBe(
      '2024-02-29 20:00:00 -05:00',
    );
    expect(shown(zonedBytes({ year: 2100, month: 3, day: 1 }, -1))).toBe(
      '2100-02-28 23:00:00 -01:00',
    );
    expect(shown(zonedBytes({ year: 2000, month: 3, day: 1 }, -1))).toBe(
      '2000-02-29 23:00:00 -01:00',
    );
  });

  it('leaves a value with a named region in UTC and says so', () => {
    const bytes = zonedBytes({ year: 2024, month: 6, day: 1, hour: 7 }, 0);
    bytes[11] = 0x80 | 0x2a;
    bytes[12] = 0x1c;
    const value = decodeOracleDate(bytes);
    expect(value.offsetMinutes).toBeNull();
    expect(value.time).toBe('07:00:00');
    expect(value.format(0)).toBe('2024-06-01 07:00:00 UTC');
  });
});

describe('OracleDateText.format', () => {
  const value = new OracleDateText('2024-02-29', '10:00:00', 5, undefined);

  it('writes no fraction for zero digits', () => {
    expect(value.format(0)).toBe('2024-02-29 10:00:00');
    expect(value.format(-1)).toBe('2024-02-29 10:00:00');
  });

  it('cuts the nine-digit fraction to the given digits without rounding', () => {
    expect(value.format(9)).toBe('2024-02-29 10:00:00.000000005');
    expect(value.format(6)).toBe('2024-02-29 10:00:00.000000');
    const late = new OracleDateText('2024-02-29', '10:00:00', 999_999_999, undefined);
    expect(late.format(3)).toBe('2024-02-29 10:00:00.999');
    expect(late.format(1)).toBe('2024-02-29 10:00:00.9');
  });

  it('adds the offset with its sign, or UTC for a named region', () => {
    expect(new OracleDateText('2024-01-01', '00:00:00', 0, 0).format(0)).toBe(
      '2024-01-01 00:00:00 +00:00',
    );
    expect(new OracleDateText('2024-01-01', '00:00:00', 0, 345).format(0)).toBe(
      '2024-01-01 00:00:00 +05:45',
    );
    expect(new OracleDateText('2024-01-01', '00:00:00', 0, -570).format(0)).toBe(
      '2024-01-01 00:00:00 -09:30',
    );
    expect(new OracleDateText('2024-01-01', '00:00:00', 0, null).format(2)).toBe(
      '2024-01-01 00:00:00.00 UTC',
    );
  });
});

describe('installExactDates', () => {
  type Reader = (this: { readBytesWithLength(): Uint8Array | null | undefined }) => unknown;
  const reader = (): Reader => BaseBuffer.prototype.readOracleDate as Reader;

  it('makes the driver read column dates as their exact parts', () => {
    installExactDates();
    const bytes = Uint8Array.from(timestampBytes({ year: 2024, month: 2, day: 29, hour: 1 }, 7));
    const value = reader().call({ readBytesWithLength: () => bytes });
    expect(value).toBeInstanceOf(OracleDateText);
    expect((value as OracleDateText).format(9)).toBe('2024-02-29 01:00:00.000000007');
  });

  it('reads NULL when the column has no bytes', () => {
    installExactDates();
    expect(reader().call({ readBytesWithLength: () => null })).toBeNull();
    expect(reader().call({ readBytesWithLength: () => undefined })).toBeNull();
  });

  it('replaces the method only once', () => {
    installExactDates();
    const installed = BaseBuffer.prototype.readOracleDate;
    const stand = (): string => 'stand-in';
    BaseBuffer.prototype.readOracleDate = stand;
    try {
      installExactDates();
      expect(BaseBuffer.prototype.readOracleDate).toBe(stand);
    } finally {
      BaseBuffer.prototype.readOracleDate = installed;
    }
  });
});
