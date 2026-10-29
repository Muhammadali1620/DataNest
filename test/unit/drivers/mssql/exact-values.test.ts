import { describe, expect, it } from 'vitest';
// eslint-disable-next-line @typescript-eslint/no-require-imports
import valueParser = require('tedious/lib/value-parser');
// eslint-disable-next-line @typescript-eslint/no-require-imports
import helpers = require('tedious/lib/token/helpers');
import {
  civilDate,
  decodeExact,
  ExactText,
  installExactValues,
  scaledText,
  timeText,
} from '../../../../src/drivers/mssql/exact-values';

/** Little-endian bytes of a non-negative integer. */
function le(value: bigint | number, bytes: number): number[] {
  let rest = BigInt(value);
  const out: number[] = [];
  for (let index = 0; index < bytes; index++) {
    out.push(Number(rest & 0xffn));
    rest >>= 8n;
  }
  return out;
}

/** Two's complement little-endian bytes of a signed integer. */
function signed(value: number, bytes: number): number[] {
  return le(BigInt.asUintN(bytes * 8, BigInt(value)), bytes);
}

/** Days from 0001-01-01, the way DATE counts them. */
function days0001(date: string): number {
  return Date.parse(`${date}T00:00:00Z`) / 86_400_000 + 719_162;
}

function meta(name: string, scale?: number) {
  return { type: { name }, ...(scale === undefined ? {} : { scale }) };
}

function decode(name: string, bytes: number[], scale?: number, offset = 0) {
  return decodeExact(Buffer.from(bytes), offset, meta(name, scale));
}

function value(name: string, bytes: number[], scale?: number): ExactText | null | undefined {
  return decode(name, bytes, scale)?.value;
}

describe('decodeExact: decimals and money', () => {
  it('reads DECIMAL with every scale digit and its sign', () => {
    expect(value('DecimalN', [5, 0, ...le(1250, 4)], 2)).toEqual(
      new ExactText('decimal', '-12.50'),
    );
    expect(value('NumericN', [5, 1, ...le(5, 4)], 3)).toEqual(new ExactText('decimal', '0.005'));
    expect(value('DecimalN', [5, 1, ...le(42, 4)], 0)).toEqual(new ExactText('decimal', '42'));
  });

  it('keeps 38 digits that a JS number would round', () => {
    const digits = 12345678901234567890123456789012345678n;
    expect(value('NumericN', [17, 1, ...le(digits, 16)], 0)?.text).toBe(digits.toString());
    expect(value('DecimalN', [17, 1, ...le(123456789012345678900123456789n, 16)], 10)?.text).toBe(
      '12345678901234567890.0123456789',
    );
  });

  it('never writes a negative zero', () => {
    expect(value('DecimalN', [5, 0, ...le(0, 4)], 2)?.text).toBe('0.00');
  });

  it('reads NULL from a zero length', () => {
    const decoded = decode('DecimalN', [0, 99], 2);
    expect(decoded).toEqual({ value: null, offset: 1 });
  });

  it('reads MONEY high half first, SMALLMONEY as one integer, both with four digits', () => {
    const big = 9223372036854775807n;
    const high = Number(big >> 32n);
    const low = Number(big & 0xffffffffn);
    expect(value('Money', [...signed(high, 4), ...le(low, 4)])?.text).toBe('922337203685477.5807');
    expect(value('Money', [...signed(-1, 4), ...le(2 ** 32 - 10_000, 4)])?.text).toBe('-1.0000');
    expect(value('SmallMoney', signed(-2147483648, 4))?.text).toBe('-214748.3648');
    expect(value('MoneyN', [4, ...signed(12_345, 4)])?.text).toBe('1.2345');
    expect(value('MoneyN', [8, ...le(0, 4), ...le(10_000, 4)])?.text).toBe('1.0000');
    expect(value('MoneyN', [0])).toBeNull();
  });

  it('tags money and decimals as decimal', () => {
    expect(value('Money', [...le(0, 4), ...le(1, 4)])?.kind).toBe('decimal');
  });
});

describe('decodeExact: dates and times', () => {
  it('reads DATE as days since 0001-01-01', () => {
    expect(value('Date', [3, ...le(0, 3)])?.text).toBe('0001-01-01');
    expect(value('Date', [3, ...le(days0001('2024-02-29'), 3)])?.text).toBe('2024-02-29');
    expect(value('Date', [3, ...le(days0001('9999-12-31'), 3)])?.text).toBe('9999-12-31');
    expect(value('Date', [0])).toBeNull();
  });

  it('reads TIME with as many fraction digits as its scale', () => {
    const ticks = 86_399 * 10 ** 7 + 1_234_567;
    expect(value('Time', [5, ...le(ticks, 5)], 7)?.text).toBe('23:59:59.1234567');
    expect(value('Time', [3, ...le(12 * 3600, 3)], 0)?.text).toBe('12:00:00');
    expect(value('Time', [4, ...le(3600 * 1000 + 120, 4)], 3)?.text).toBe('01:00:00.120');
  });

  it('reads DATETIME2 as time then date', () => {
    const ticks = 86_399 * 10 ** 7 + 9_999_999;
    expect(
      value('DateTime2', [8, ...le(ticks, 5), ...le(days0001('9999-12-31'), 3)], 7)?.text,
    ).toBe('9999-12-31 23:59:59.9999999');
    expect(value('DateTime2', [6, ...le(0, 3), ...le(0, 3)], 0)?.text).toBe('0001-01-01 00:00:00');
  });

  it('shows DATETIMEOFFSET in its own local time with the offset', () => {
    // 2024-06-15 09:00:00 UTC at +03:00 is noon there.
    const utc = 9 * 3600;
    const bytes = [8, ...le(utc, 3), ...le(days0001('2024-06-15'), 3), ...signed(180, 2)];
    expect(value('DateTimeOffset', bytes, 0)?.text).toBe('2024-06-15 12:00:00 +03:00');
  });

  it('moves the date when the offset crosses midnight, either way', () => {
    // 2024-01-01 06:00 UTC at -05:30 → 2024-01-01 00:30; 01:00 UTC → 2023-12-31 19:30.
    const at = (seconds: number, date: string, minutes: number) =>
      value(
        'DateTimeOffset',
        [8, ...le(seconds, 3), ...le(days0001(date), 3), ...signed(minutes, 2)],
        0,
      )?.text;
    expect(at(6 * 3600, '2024-01-01', -330)).toBe('2024-01-01 00:30:00 -05:30');
    expect(at(3600, '2024-01-01', -330)).toBe('2023-12-31 19:30:00 -05:30');
    expect(at(23 * 3600, '2024-12-31', 120)).toBe('2025-01-01 01:00:00 +02:00');
  });

  it('reads DATETIME to the millisecond the way the server rounds it', () => {
    const days = days0001('2024-12-31') - days0001('1900-01-01');
    const ticks = 86_399 * 300 + 299;
    expect(value('DateTime', [...signed(days, 4), ...le(ticks, 4)])?.text).toBe(
      '2024-12-31 23:59:59.997',
    );
    const before1900 = days0001('1753-01-01') - days0001('1900-01-01');
    expect(value('DateTimeN', [8, ...signed(before1900, 4), ...le(0, 4)])?.text).toBe(
      '1753-01-01 00:00:00.000',
    );
  });

  it('reads SMALLDATETIME as days and minutes', () => {
    const days = days0001('2024-12-31') - days0001('1900-01-01');
    expect(value('SmallDateTime', [...le(days, 2), ...le(23 * 60 + 59, 2)])?.text).toBe(
      '2024-12-31 23:59:00',
    );
    expect(value('DateTimeN', [4, ...le(0, 2), ...le(0, 2)])?.text).toBe('1900-01-01 00:00:00');
    expect(value('DateTimeN', [0])).toBeNull();
  });

  it('tags dates and times as datetime', () => {
    expect(value('Date', [3, 0, 0, 0])?.kind).toBe('datetime');
  });
});

describe('decodeExact: parsing', () => {
  it('starts at the offset and says where the value ends', () => {
    expect(decode('DecimalN', [0xaa, 0xbb, 5, 1, ...le(7, 4), 0xcc], 1, 2)).toEqual({
      value: new ExactText('decimal', '0.7'),
      offset: 8,
    });
    expect(decode('Money', [9, ...le(0, 4), ...le(1, 4)], undefined, 1)?.offset).toBe(9);
  });

  it('asks for more data when a value is cut by a packet boundary', () => {
    expect(() => decode('DecimalN', [5, 1, 0])).toThrow(helpers.NotEnoughDataError);
    expect(() => decode('DecimalN', [])).toThrow(helpers.NotEnoughDataError);
    expect(() => decode('Money', [1, 2, 3])).toThrow(helpers.NotEnoughDataError);
  });

  it('leaves every other type to tedious', () => {
    expect(decode('Int', [1, 0, 0, 0])).toBeUndefined();
    expect(decode('NVarChar', [0])).toBeUndefined();
    expect(decode('Variant', [0])).toBeUndefined();
  });

  it('assumes seven fraction digits when the scale is missing', () => {
    expect(value('Time', [5, ...le(1, 5)])?.text).toBe('00:00:00.0000001');
  });
});

describe('text helpers', () => {
  it('places the decimal point by the scale', () => {
    expect(scaledText(false, 5n, 3)).toBe('0.005');
    expect(scaledText(true, 123n, 0)).toBe('-123');
    expect(scaledText(true, 0n, 1)).toBe('0.0');
  });

  it('turns day numbers into proleptic Gregorian dates, years 1 to 99 included', () => {
    expect(civilDate(0)).toBe('1970-01-01');
    expect(civilDate(-719_162)).toBe('0001-01-01');
    expect(civilDate(-719_162 + 365 * 50 + 12)).toBe('0051-01-01');
    expect(civilDate(19_782)).toBe('2024-02-29');
  });

  it('writes a time of day with the scale digits', () => {
    expect(timeText(0, 0)).toBe('00:00:00');
    expect(timeText(45_296_789, 3)).toBe('12:34:56.789');
  });
});

describe('installExactValues', () => {
  it('makes tedious read exact types through the decoder, once', () => {
    installExactValues();
    const wrapped = valueParser.readValue;
    installExactValues();
    expect(valueParser.readValue).toBe(wrapped);
    const result = valueParser.readValue(
      Buffer.from([5, 1, ...le(1250, 4)]),
      0,
      meta('DecimalN', 2) as never,
      {} as never,
    );
    expect(result.value).toEqual(new ExactText('decimal', '12.50'));
    expect(result.offset).toBe(6);
  });

  it('leaves other types to tedious', () => {
    installExactValues();
    const result = valueParser.readValue(
      Buffer.from([4, ...le(42, 4)]),
      0,
      meta('IntN') as never,
      {} as never,
    );
    expect(result.value).toBe(42);
  });
});
