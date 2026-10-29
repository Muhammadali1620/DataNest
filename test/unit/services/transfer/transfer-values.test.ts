import { describe, expect, it } from 'vitest';
import {
  toUtc,
  transferValue,
  withFullOffset,
} from '../../../../src/services/transfer/transfer-values';

describe('toUtc', () => {
  it('moves a moment with a zone to UTC, keeping the fraction', () => {
    expect(toUtc('2024-03-01 01:30:00+03')).toBe('2024-02-29 22:30:00');
    expect(toUtc('2024-03-01T01:30:00.123456-05:30')).toBe('2024-03-01 07:00:00.123456');
    expect(toUtc('2024-12-31 23:59:59Z')).toBe('2024-12-31 23:59:59');
    expect(toUtc('2024-01-01 10:00+0100')).toBe('2024-01-01 09:00:00');
  });

  it('leaves alone what has no zone', () => {
    expect(toUtc('2024-03-01 01:30:00')).toBeUndefined();
    expect(toUtc('not a date')).toBeUndefined();
  });
});

describe('transferValue', () => {
  it('turns numbers and words into booleans for a boolean column', () => {
    expect(transferValue(1, { kind: 'boolean' })).toBe(true);
    expect(transferValue(0, { kind: 'boolean' })).toBe(false);
    expect(transferValue('t', { kind: 'boolean' })).toBe(true);
    expect(transferValue({ kind: 'bigint', text: '0' }, { kind: 'boolean' })).toBe(false);
    expect(transferValue('maybe', { kind: 'boolean' })).toBe('maybe');
  });

  it('turns booleans into numbers for a number column', () => {
    expect(transferValue(true, { kind: 'integer', bytes: 1, unsigned: false })).toBe(1);
    expect(transferValue(false, { kind: 'decimal' })).toBe(0);
  });

  it('writes a zoned moment as UTC into a column without a zone', () => {
    expect(
      transferValue(
        { kind: 'datetime', text: '2024-03-01 01:30:00+03' },
        { kind: 'datetime', zone: false },
      ),
    ).toEqual({ kind: 'datetime', text: '2024-02-29 22:30:00' });
    const zoned = { kind: 'datetime', text: '2024-03-01 01:30:00+03' } as const;
    expect(transferValue(zoned, { kind: 'datetime', zone: true })).toEqual({
      kind: 'datetime',
      text: '2024-03-01 01:30:00+03:00',
    });
    const local = { kind: 'datetime', text: '2024-03-01 01:30:00' } as const;
    expect(transferValue(local, { kind: 'datetime', zone: true })).toBe(local);
  });

  it('spells every offset in full, the one form SQL Server reads', () => {
    expect(withFullOffset('2024-03-01 01:30:00+03')).toBe('2024-03-01 01:30:00+03:00');
    expect(withFullOffset('2024-03-01 01:30:00.5-0530')).toBe('2024-03-01 01:30:00.5-05:30');
    expect(withFullOffset('2024-03-01T01:30:00Z')).toBe('2024-03-01T01:30:00+00:00');
    expect(withFullOffset('2024-06-15 12:00:00.1234567 +03:00')).toBe(
      '2024-06-15 12:00:00.1234567+03:00',
    );
    expect(withFullOffset('2024-03-01 01:30:00')).toBeUndefined();
    expect(withFullOffset('not a date')).toBeUndefined();
  });

  it('marks text for a JSON column and unwraps JSON for a text one', () => {
    expect(transferValue('{"a":1}', { kind: 'json' })).toEqual({ kind: 'json', text: '{"a":1}' });
    expect(transferValue({ kind: 'json', text: '[1]' }, { kind: 'text' })).toBe('[1]');
    expect(transferValue(true, { kind: 'string', length: 5, fixed: false })).toBe('true');
  });

  it('passes everything else through, NULL included', () => {
    expect(transferValue(null, { kind: 'boolean' })).toBeNull();
    expect(transferValue('2024-01-01', { kind: 'date' })).toBe('2024-01-01');
    const bytes = { kind: 'binary', size: 1, preview: 'ff' } as const;
    expect(transferValue(bytes, { kind: 'binary' })).toBe(bytes);
  });
});
