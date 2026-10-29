import { describe, expect, it } from 'vitest';
import {
  enumOptions,
  inputKindOf,
  isTextEditable,
  parseCellInput,
} from '../../../src/shared/cell-input';

describe('inputKindOf', () => {
  it.each([
    ['int', 'integer'],
    ['INT(11)', 'integer'],
    ['int unsigned', 'integer'],
    ['bigint', 'integer'],
    ['bigint(20) unsigned', 'integer'],
    ['smallint', 'integer'],
    ['tinyint(1)', 'integer'],
    ['integer', 'integer'],
    ['serial', 'integer'],
    ['bigserial', 'integer'],
    ['int4', 'integer'],
    ['year', 'integer'],
    ['decimal(10,2)', 'number'],
    ['numeric(8, 3)', 'number'],
    ['float', 'number'],
    ['double', 'number'],
    ['double precision', 'number'],
    ['real', 'number'],
    ['boolean', 'boolean'],
    ['bool', 'boolean'],
    ['date', 'date'],
    ['time', 'time'],
    ['time without time zone', 'time'],
    ['datetime', 'datetime'],
    ['datetime(3)', 'datetime'],
    ['timestamp', 'datetime'],
    ['timestamp without time zone', 'datetime'],
    ['timestamp with time zone', 'datetime'],
    ['json', 'json'],
    ['jsonb', 'json'],
    ["enum('a','b')", 'enum'],
    ['blob', 'binary'],
    ['longblob', 'binary'],
    ['varbinary(16)', 'binary'],
    ['bytea', 'binary'],
    ['varchar(255)', 'text'],
    ['text', 'text'],
    ['uuid', 'text'],
    ['', 'text'],
    // SQL Server (V6.2): BIT is its boolean; MySQL's bit(n) is not.
    ['bit', 'boolean'],
    ['bit(8)', 'text'],
    ['tinyint', 'integer'],
    ['money', 'number'],
    ['smallmoney', 'number'],
    ['datetime2(7)', 'datetime'],
    ['datetimeoffset(7)', 'datetime'],
    ['smalldatetime', 'datetime'],
    ['time(7)', 'time'],
    ['image', 'binary'],
    ['varbinary(max)', 'binary'],
    ['nvarchar(max)', 'text'],
    ['uniqueidentifier', 'text'],
    ['xml', 'text'],
  ] as const)('reads %s as %s', (type, kind) => {
    expect(inputKindOf(type)).toBe(kind);
  });

  it('treats an unknown type as text', () => {
    expect(inputKindOf(undefined)).toBe('text');
    expect(inputKindOf('geometry')).toBe('text');
  });
});

describe('isTextEditable', () => {
  it('is false only for binary', () => {
    expect(isTextEditable('binary')).toBe(false);
    expect(isTextEditable('text')).toBe(true);
    expect(isTextEditable('json')).toBe(true);
  });
});

describe('enumOptions', () => {
  it('reads the allowed values, with escaped quotes and commas', () => {
    expect(enumOptions("enum('new','paid','it''s, ok')")).toEqual(['new', 'paid', "it's, ok"]);
  });

  it('is undefined for other types', () => {
    expect(enumOptions('varchar(5)')).toBeUndefined();
    expect(enumOptions(undefined)).toBeUndefined();
  });

  it('reads an empty list', () => {
    expect(enumOptions('enum()')).toEqual([]);
  });
});

describe('parseCellInput', () => {
  const ok = (value: unknown) => ({ ok: true, value });
  const bad = (problem: string) => ({ ok: false, problem });

  describe('text', () => {
    it('keeps the text exactly, empty string included', () => {
      expect(parseCellInput('text', '  a b ')).toEqual(ok('  a b '));
      expect(parseCellInput('text', '')).toEqual(ok(''));
    });
  });

  describe('integer', () => {
    it('reads whole numbers, trimmed, with a sign', () => {
      expect(parseCellInput('integer', ' 42 ')).toEqual(ok(42));
      expect(parseCellInput('integer', '-7')).toEqual(ok(-7));
      expect(parseCellInput('integer', '+5')).toEqual(ok(5));
      expect(parseCellInput('integer', '007')).toEqual(ok(7));
      expect(parseCellInput('integer', '0')).toEqual(ok(0));
    });

    it('keeps a number that does not fit a double as exact text', () => {
      expect(parseCellInput('integer', '9223372036854775807')).toEqual(
        ok({ kind: 'bigint', text: '9223372036854775807' }),
      );
      expect(parseCellInput('integer', '-9223372036854775808')).toEqual(
        ok({ kind: 'bigint', text: '-9223372036854775808' }),
      );
    });

    it('rejects decimals, words, empty input and mixed text', () => {
      for (const input of ['1.5', 'abc', '', ' ', '1e3', '12a', '--1']) {
        expect(parseCellInput('integer', input)).toEqual(bad('invalid-integer'));
      }
    });
  });

  describe('number', () => {
    it('reads plain numbers as numbers', () => {
      expect(parseCellInput('number', '10.5')).toEqual(ok(10.5));
      expect(parseCellInput('number', '-3')).toEqual(ok(-3));
    });

    it('keeps digits a double would lose', () => {
      expect(parseCellInput('number', '0.10')).toEqual(ok({ kind: 'decimal', text: '0.10' }));
      expect(parseCellInput('number', '12345678901234567890.123456789')).toEqual(
        ok({ kind: 'decimal', text: '12345678901234567890.123456789' }),
      );
      expect(parseCellInput('number', '1e5')).toEqual(ok({ kind: 'decimal', text: '1e5' }));
    });

    it('rejects things that are not numbers', () => {
      for (const input of ['', 'abc', '1,5', 'NaN', 'Infinity', '1.2.3', '.']) {
        expect(parseCellInput('number', input)).toEqual(bad('invalid-number'));
      }
    });
  });

  describe('boolean', () => {
    it('reads the usual spellings, in any case', () => {
      for (const input of ['true', 'TRUE', 't', '1', 'yes', 'On']) {
        expect(parseCellInput('boolean', input)).toEqual(ok(true));
      }
      for (const input of ['false', 'False', 'f', '0', 'no', 'off']) {
        expect(parseCellInput('boolean', input)).toEqual(ok(false));
      }
    });

    it('rejects anything else', () => {
      expect(parseCellInput('boolean', 'maybe')).toEqual(bad('invalid-boolean'));
      expect(parseCellInput('boolean', '')).toEqual(bad('invalid-boolean'));
    });
  });

  describe('date', () => {
    it('reads a real calendar date', () => {
      expect(parseCellInput('date', '2024-02-29')).toEqual(
        ok({ kind: 'datetime', text: '2024-02-29' }),
      );
    });

    it('rejects impossible dates and other shapes', () => {
      for (const input of [
        '2023-02-29',
        '2024-13-01',
        '2024-00-10',
        '2024-04-31',
        '24-01-01',
        '2024/01/01',
        '',
      ]) {
        expect(parseCellInput('date', input)).toEqual(bad('invalid-date'));
      }
    });

    it('knows the century rule for leap years', () => {
      expect(parseCellInput('date', '1900-02-29')).toEqual(bad('invalid-date'));
      expect(parseCellInput('date', '2000-02-29').ok).toBe(true);
    });
  });

  describe('time', () => {
    it('reads times with optional seconds, fractions, zones and a sign', () => {
      for (const input of [
        '12:30',
        '12:30:45',
        '12:30:45.123456',
        '12:30:45+02',
        '12:30:45-05:30',
        '838:59:59',
        '-12:00:00',
      ]) {
        expect(parseCellInput('time', input)).toEqual(ok({ kind: 'datetime', text: input }));
      }
    });

    it('rejects bad minutes, seconds and shapes', () => {
      for (const input of ['12:60', '12:30:61', '1230', 'noon', '', '12:30:45.1234567']) {
        expect(parseCellInput('time', input)).toEqual(bad('invalid-time'));
      }
    });
  });

  describe('datetime', () => {
    it('reads date and time, with a space or the browser T', () => {
      expect(parseCellInput('datetime', '2024-03-01 10:20:30')).toEqual(
        ok({ kind: 'datetime', text: '2024-03-01 10:20:30' }),
      );
      expect(parseCellInput('datetime', '2024-03-01T10:20')).toEqual(
        ok({ kind: 'datetime', text: '2024-03-01 10:20' }),
      );
    });

    it('keeps fractions and zones', () => {
      expect(parseCellInput('datetime', '2024-03-01 10:20:30.123456+02:00')).toEqual(
        ok({ kind: 'datetime', text: '2024-03-01 10:20:30.123456+02:00' }),
      );
      expect(parseCellInput('datetime', '2024-03-01 10:20:30Z').ok).toBe(true);
    });

    it('rejects impossible moments and date-only input', () => {
      for (const input of [
        '2024-03-01',
        '2024-02-30 10:00:00',
        '2024-03-01 24:00:00',
        '2024-03-01 10:61',
        'x',
        '',
      ]) {
        expect(parseCellInput('datetime', input)).toEqual(bad('invalid-datetime'));
      }
    });
  });

  describe('json', () => {
    it('accepts any valid JSON and keeps its text', () => {
      for (const input of ['{"a": 1}', '[1, 2]', '"x"', '12', 'null', 'true']) {
        expect(parseCellInput('json', input)).toEqual(ok({ kind: 'json', text: input }));
      }
    });

    it('rejects broken JSON', () => {
      for (const input of ['{a: 1}', '', '{"a": }', "{'a': 1}"]) {
        expect(parseCellInput('json', input)).toEqual(bad('invalid-json'));
      }
    });
  });

  describe('enum', () => {
    it('accepts a listed value and only those', () => {
      expect(parseCellInput('enum', 'new', ['new', 'paid'])).toEqual(ok('new'));
      expect(parseCellInput('enum', 'NEW', ['new', 'paid'])).toEqual(bad('invalid-enum'));
      expect(parseCellInput('enum', 'x', [])).toEqual(bad('invalid-enum'));
    });

    it('accepts any text when the allowed values are unknown', () => {
      expect(parseCellInput('enum', 'whatever')).toEqual(ok('whatever'));
    });
  });

  it('refuses binary until the value panel exists', () => {
    expect(parseCellInput('binary', 'deadbeef')).toEqual(bad('unsupported'));
  });
});

describe('ClickHouse types (V6.3)', () => {
  it.each([
    ['UInt8', 'integer'],
    ['UInt16', 'integer'],
    ['UInt32', 'integer'],
    ['UInt64', 'integer'],
    ['UInt256', 'integer'],
    ['Int8', 'integer'],
    ['Int128', 'integer'],
    ['Float32', 'number'],
    ['Float64', 'number'],
    ['Decimal(10, 2)', 'number'],
    ['Bool', 'boolean'],
    ['Date', 'date'],
    ['Date32', 'date'],
    ['DateTime', 'datetime'],
    ["DateTime64(3, 'UTC')", 'datetime'],
    ["Enum8('a' = 1, 'b' = 2)", 'enum'],
    ['Nullable(UInt8)', 'integer'],
    ['LowCardinality(String)', 'text'],
    ['LowCardinality(Nullable(Date32))', 'date'],
    ['Nullable(Decimal(38, 10))', 'number'],
    ['String', 'text'],
    ['UUID', 'text'],
    ['Array(Int32)', 'text'],
    ['Map(String, Int32)', 'text'],
  ] as const)('reads %s as %s', (type, kind) => {
    expect(inputKindOf(type)).toBe(kind);
  });

  it('lists the values of an Enum8 or Enum16, also when Nullable', () => {
    expect(enumOptions("Enum8('a' = 1, 'b' = 2)")).toEqual(['a', 'b']);
    expect(enumOptions("Nullable(Enum16('new' = 1, 'paid' = 2))")).toEqual(['new', 'paid']);
    expect(enumOptions('Int8')).toBeUndefined();
  });
});

describe('Oracle types (V6.4)', () => {
  const ok = (value: unknown) => ({ ok: true, value });
  const bad = (problem: string) => ({ ok: false, problem });

  it.each([
    ['NUMBER(10)', 'number'],
    ['NUMBER(10,2)', 'number'],
    ['INTEGER', 'integer'],
    ['VARCHAR2(255 CHAR)', 'text'],
    ['NVARCHAR2(50)', 'text'],
    ['CLOB', 'text'],
    ['TIMESTAMP(6)', 'datetime'],
    ['TIMESTAMP(6) WITH TIME ZONE', 'datetime'],
    ['BOOLEAN', 'boolean'],
    ['RAW(16)', 'binary'],
    ['BLOB', 'binary'],
    ['JSON', 'json'],
  ] as const)('reads %s as %s', (type, kind) => {
    expect(inputKindOf(type, 'oracle')).toBe(kind);
  });

  it("edits Oracle's DATE as a moment, since it holds a time of day too", () => {
    expect(inputKindOf('DATE', 'oracle')).toBe('datetime');
    expect(inputKindOf('DATE', 'mysql')).toBe('date');
    expect(inputKindOf('DATE')).toBe('date');
  });

  it('reads up to nine fraction digits, as TIMESTAMP(9) and datetime2(7) show them', () => {
    expect(parseCellInput('datetime', '9999-12-31 23:59:59.999999999')).toEqual(
      ok({ kind: 'datetime', text: '9999-12-31 23:59:59.999999999' }),
    );
    expect(parseCellInput('datetime', '2024-01-01 00:00:00.1234567890')).toEqual(
      bad('invalid-datetime'),
    );
  });

  it('takes the zone after a space, as the grid shows it, and writes it next to the time', () => {
    expect(parseCellInput('datetime', '2024-06-15 12:00:00.123456 +03:00')).toEqual(
      ok({ kind: 'datetime', text: '2024-06-15 12:00:00.123456+03:00' }),
    );
    expect(parseCellInput('datetime', '2024-06-15 12:00:00 Z')).toEqual(
      ok({ kind: 'datetime', text: '2024-06-15 12:00:00Z' }),
    );
    expect(parseCellInput('datetime', '2024-06-15 12:00:00  +03:00')).toEqual(
      bad('invalid-datetime'),
    );
  });
});
