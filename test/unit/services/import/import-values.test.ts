import { describe, expect, it } from 'vitest';
import { convertValue } from '../../../../src/services/import/import-values';

const CSV = { emptyIsNull: true, nullText: '\\N' };
const KEEP_EMPTY = { emptyIsNull: false, nullText: '' };

describe('convertValue', () => {
  it('reads text by the column type, as the grid does', () => {
    expect(convertValue('42', 'int', CSV)).toEqual({ ok: true, value: 42 });
    expect(convertValue(' 42 ', 'bigint', CSV)).toEqual({ ok: true, value: 42 });
    expect(convertValue('9007199254740993', 'bigint', CSV)).toEqual({
      ok: true,
      value: { kind: 'bigint', text: '9007199254740993' },
    });
    expect(convertValue('2024-02-29', 'date', CSV)).toMatchObject({ ok: true });
    expect(convertValue('yes', 'boolean', CSV)).toEqual({ ok: true, value: true });
    expect(convertValue('b', "enum('a','b')", CSV)).toEqual({ ok: true, value: 'b' });
  });

  it('writes true and false into a MySQL BOOLEAN, which is TINYINT(1)', () => {
    expect(convertValue('true', 'tinyint(1)', CSV)).toEqual({ ok: true, value: 1 });
    expect(convertValue('No', 'tinyint(1) unsigned', CSV)).toEqual({ ok: true, value: 0 });
    expect(convertValue('7', 'tinyint(1)', CSV)).toEqual({ ok: true, value: 7 });
    expect(convertValue('true', 'tinyint(4)', CSV)).toEqual({
      ok: false,
      problem: 'invalid-integer',
    });
  });

  it('refuses what does not fit, with the reason', () => {
    expect(convertValue('4x', 'int', CSV)).toEqual({ ok: false, problem: 'invalid-integer' });
    expect(convertValue('2023-02-29', 'date', CSV)).toEqual({ ok: false, problem: 'invalid-date' });
    expect(convertValue('c', "enum('a','b')", CSV)).toEqual({ ok: false, problem: 'invalid-enum' });
    expect(convertValue('{', 'json', CSV)).toEqual({ ok: false, problem: 'invalid-json' });
  });

  it('keeps text exactly, spaces included', () => {
    expect(convertValue('  padded ', 'varchar(20)', CSV)).toEqual({ ok: true, value: '  padded ' });
  });

  it('reads NULL from the NULL text, a missing field, and an empty one when asked', () => {
    expect(convertValue('\\N', 'text', CSV)).toEqual({ ok: true, value: null });
    expect(convertValue(undefined, 'int', CSV)).toEqual({ ok: true, value: null });
    expect(convertValue('', 'text', CSV)).toEqual({ ok: true, value: null });
    expect(convertValue('', 'text', KEEP_EMPTY)).toEqual({ ok: true, value: '' });
    // An empty field is never a number or a date, so it is NULL there anyway.
    expect(convertValue('', 'int', KEEP_EMPTY)).toEqual({ ok: true, value: null });
  });

  it('reads binary values written as hex', () => {
    expect(convertValue('0xCAFE', 'blob', CSV)).toEqual({
      ok: true,
      value: { kind: 'binary', size: 2, preview: 'cafe' },
    });
    expect(convertValue('\\x00ff', 'bytea', CSV)).toMatchObject({ ok: true });
    expect(convertValue('0xABC', 'blob', CSV)).toEqual({ ok: false, problem: 'invalid-binary' });
    expect(convertValue('hello', 'blob', CSV)).toEqual({ ok: false, problem: 'invalid-binary' });
  });

  it('reads JSON values: numbers as written, booleans, nested JSON', () => {
    expect(convertValue({ number: '0.10' }, 'decimal(10,2)', KEEP_EMPTY)).toEqual({
      ok: true,
      value: { kind: 'decimal', text: '0.10' },
    });
    expect(convertValue(true, 'boolean', KEEP_EMPTY)).toEqual({ ok: true, value: true });
    expect(convertValue(false, 'tinyint(1)', KEEP_EMPTY)).toEqual({ ok: true, value: 0 });
    expect(convertValue(null, 'int', KEEP_EMPTY)).toEqual({ ok: true, value: null });
    expect(convertValue({ json: '{"a":1}' }, 'jsonb', KEEP_EMPTY)).toMatchObject({ ok: true });
    expect(convertValue({ json: '[1]' }, 'text', KEEP_EMPTY)).toEqual({ ok: true, value: '[1]' });
    expect(convertValue({ json: '[1]' }, 'int', KEEP_EMPTY)).toEqual({
      ok: false,
      problem: 'not-a-value',
    });
  });
});
