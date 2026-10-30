import { describe, expect, it } from 'vitest';
import {
  canonicalDateTime,
  canonicalJson,
  canonicalNumber,
  comparableText,
  keyOf,
  rowHash,
  sameValue,
} from '../../../../src/services/data-compare/comparable';
import { retainBytes } from '../../../../src/shared/binary-bytes';
import type { BinaryValue } from '../../../../src/shared/cell-value';

describe('canonicalNumber', () => {
  it('writes equal numbers the same way', () => {
    expect(canonicalNumber('010.500')).toBe('n10.5');
    expect(canonicalNumber('10.5')).toBe('n10.5');
    expect(canonicalNumber('-0.000')).toBe('n0');
    expect(canonicalNumber('1e3')).toBe('n1000');
    expect(canonicalNumber('1.5E-2')).toBe('n0.015');
    expect(canonicalNumber('9007199254740993')).toBe('n9007199254740993');
    expect(canonicalNumber('+.25')).toBe('n0.25');
    expect(canonicalNumber('-12.30')).toBe('n-12.3');
  });

  it('keeps text that is not a number apart from numbers', () => {
    expect(canonicalNumber('NaN')).toBe('sNaN');
    expect(canonicalNumber('.')).toBe('s.');
    expect(canonicalNumber('')).toBe('s');
  });
});

describe('canonicalDateTime', () => {
  it('treats separators, zero fractions and UTC as spellings', () => {
    expect(canonicalDateTime('2024-01-02T08:00:00.000Z')).toBe('2024-01-02 08:00:00');
    expect(canonicalDateTime('2024-01-02 08:00:00+00:00')).toBe('2024-01-02 08:00:00');
    expect(canonicalDateTime('2024-01-02 08:00:00.120')).toBe('2024-01-02 08:00:00.12');
    expect(canonicalDateTime('08:00:00.5')).toBe('08:00:00.5');
  });

  it('keeps other zones', () => {
    expect(canonicalDateTime('2024-01-02 08:00:00+03')).toBe('2024-01-02 08:00:00+03');
    expect(canonicalDateTime('2024-01-02 08:00:00.100+03')).toBe('2024-01-02 08:00:00.1+03');
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every depth and drops spaces', () => {
    expect(canonicalJson('{"b": 1, "a": {"y": [2, {"d": 1, "c": 2}], "x": null}}')).toBe(
      '{"a":{"x":null,"y":[2,{"c":2,"d":1}]},"b":1}',
    );
  });

  it('leaves text that is not JSON as it is', () => {
    expect(canonicalJson('{not json')).toBe('{not json');
  });
});

describe('comparableText', () => {
  it('makes numbers, flags and exact numbers of different databases equal', () => {
    expect(sameValue(10.5, { kind: 'decimal', text: '10.50' })).toBe(true);
    expect(sameValue(true, 1)).toBe(true);
    expect(sameValue(false, { kind: 'bigint', text: '0' })).toBe(true);
    expect(sameValue(5, '5')).toBe(false);
  });

  it('keeps strings exact and NULL apart from everything', () => {
    expect(sameValue('Tea', 'tea')).toBe(false);
    expect(sameValue(null, '')).toBe(false);
    expect(sameValue(null, null)).toBe(true);
    expect(comparableText(null)).not.toBe(comparableText('\u0000'));
  });

  it('reads text as JSON or a date where the column type says so', () => {
    const json = { kind: 'json', text: '{"k": 1, "j": 2}' } as const;
    expect(sameValue(json, '{"j":2,"k":1}')).toBe(false);
    expect(sameValue(json, '{"j":2,"k":1}', 'json')).toBe(true);
    const at = { kind: 'datetime', text: '2024-01-02T08:00:00Z' } as const;
    expect(sameValue(at, '2024-01-02 08:00:00')).toBe(false);
    expect(sameValue(at, '2024-01-02 08:00:00', 'datetime')).toBe(true);
  });

  it('compares binary values by their full bytes where the host kept them', () => {
    const a: BinaryValue = { kind: 'binary', size: 3, preview: '010203' };
    const b: BinaryValue = { kind: 'binary', size: 3, preview: '010203' };
    expect(sameValue(a, b)).toBe(true);
    retainBytes(a, new Uint8Array([1, 2, 3]));
    retainBytes(b, new Uint8Array([1, 2, 4]));
    expect(sameValue(a, b)).toBe(false);
  });
});

describe('keyOf and rowHash', () => {
  it('never lets the values of a key run together', () => {
    expect(keyOf(['a\u0001b', 'c'])).not.toBe(keyOf(['a', 'b\u0001c']));
    expect(keyOf(['a\\', '1'])).not.toBe(keyOf(['a', '\\1']));
    expect(keyOf([1, 'x'])).toBe(keyOf([{ kind: 'bigint', text: '1' }, 'x']));
  });

  it('hashes equal rows equal and different rows apart', () => {
    expect(rowHash([10.5, 'tea', null])).toBe(
      rowHash([{ kind: 'decimal', text: '10.50' }, 'tea', null]),
    );
    expect(rowHash(['ab', 'c'])).not.toBe(rowHash(['a', 'bc']));
    expect(rowHash(['tea', null])).not.toBe(rowHash(['tea', '']));
    const hash = rowHash(['x']);
    expect(Number.isSafeInteger(hash)).toBe(true);
    expect(hash).toBeGreaterThanOrEqual(0);
  });

  it('uses the column modes', () => {
    expect(rowHash(['{"b":1,"a":2}'], ['json'])).toBe(
      rowHash([{ kind: 'json', text: '{"a":2,"b":1}' }], ['json']),
    );
  });
});
