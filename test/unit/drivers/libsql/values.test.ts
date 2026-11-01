import { describe, expect, it } from 'vitest';
import { retainedBytes } from '../../../../src/shared/binary-bytes';
import { fromHranaValue, toHranaValue } from '../../../../src/drivers/libsql/values';

describe('toHranaValue', () => {
  it('sends null, text and numbers in the kinds the server knows', () => {
    expect(toHranaValue(null)).toEqual({ type: 'null' });
    expect(toHranaValue('a')).toEqual({ type: 'text', value: 'a' });
    expect(toHranaValue('')).toEqual({ type: 'text', value: '' });
    expect(toHranaValue(7)).toEqual({ type: 'integer', value: '7' });
    expect(toHranaValue(-3)).toEqual({ type: 'integer', value: '-3' });
    expect(toHranaValue(0)).toEqual({ type: 'integer', value: '0' });
    expect(toHranaValue(1.5)).toEqual({ type: 'float', value: 1.5 });
  });

  it('sends integers as text, so a big one is not rounded on the way', () => {
    expect(toHranaValue(2 ** 52)).toEqual({ type: 'integer', value: String(2 ** 52) });
  });
});

describe('fromHranaValue', () => {
  it('reads null, text and floats', () => {
    expect(fromHranaValue({ type: 'null' })).toBeNull();
    expect(fromHranaValue({ type: 'text', value: 'é' })).toBe('é');
    expect(fromHranaValue({ type: 'text', value: '' })).toBe('');
    expect(fromHranaValue({ type: 'float', value: 1.25 })).toBe(1.25);
  });

  it('keeps an integer a number while it is safe and exact text beyond', () => {
    expect(fromHranaValue({ type: 'integer', value: '42' })).toBe(42);
    expect(fromHranaValue({ type: 'integer', value: '-9007199254740991' })).toBe(
      -9_007_199_254_740_991,
    );
    expect(fromHranaValue({ type: 'integer', value: '9223372036854775807' })).toEqual({
      kind: 'bigint',
      text: '9223372036854775807',
    });
    expect(fromHranaValue({ type: 'integer', value: 5 })).toBe(5);
  });

  it('turns a value of the wrong shape into NULL instead of failing', () => {
    expect(fromHranaValue({ type: 'integer' })).toBeNull();
    expect(fromHranaValue({ type: 'integer', value: true })).toBeNull();
    expect(fromHranaValue({ type: 'float', value: 'x' })).toBeNull();
    expect(fromHranaValue({ type: 'float', value: Number.NaN })).toBeNull();
    expect(fromHranaValue({ type: 'text', value: 3 })).toBeNull();
    expect(fromHranaValue({ type: 'blob' })).toBeNull();
    expect(fromHranaValue('plain')).toBeNull();
    expect(fromHranaValue(null)).toBeNull();
    expect(fromHranaValue(undefined)).toBeNull();
  });

  it('reads a blob with or without base64 padding and keeps its bytes for the value panel', () => {
    // The server writes it without padding: "/w" for the single byte 0xff.
    const short = fromHranaValue({ type: 'blob', base64: '/w' });
    expect(short).toMatchObject({ kind: 'binary', size: 1, preview: 'ff' });
    const padded = fromHranaValue({ type: 'blob', base64: 'AQID' });
    expect(padded).toMatchObject({ kind: 'binary', size: 3, preview: '010203' });
    if (typeof padded === 'object' && padded !== null && padded.kind === 'binary') {
      expect([...(retainedBytes(padded) ?? [])]).toEqual([1, 2, 3]);
    }
    expect(fromHranaValue({ type: 'blob', base64: '' })).toMatchObject({ kind: 'binary', size: 0 });
  });

  it('keeps a kind it does not know readable', () => {
    expect(fromHranaValue({ type: 'vector', value: [1, 2] })).toEqual({
      kind: 'json',
      text: '{"type":"vector","value":[1,2]}',
    });
  });
});
