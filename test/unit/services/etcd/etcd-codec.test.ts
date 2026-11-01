import { describe, expect, it } from 'vitest';
import {
  afterKey,
  concatBytes,
  count,
  entryOf,
  fromBase64,
  int64,
  prefixEnd,
  startsWith,
  toBase64,
} from '../../../../src/services/etcd/etcd-codec';

const bytes = (...values: number[]): Uint8Array => Uint8Array.from(values);
const text = (value: string): Uint8Array => new TextEncoder().encode(value);

describe('base64', () => {
  it('round-trips every byte value', () => {
    const all = Uint8Array.from({ length: 256 }, (_, index) => index);
    expect(Array.from(fromBase64(toBase64(all)))).toEqual(Array.from(all));
  });

  it('reads an absent or odd field as empty', () => {
    expect(fromBase64(undefined)).toHaveLength(0);
    expect(fromBase64(5)).toHaveLength(0);
    expect(fromBase64('')).toHaveLength(0);
  });
});

describe('prefixEnd', () => {
  it('raises the last byte', () => {
    expect(Array.from(prefixEnd(text('/a/')))).toEqual(Array.from(text('/a0')));
    expect(Array.from(prefixEnd(text('abc')))).toEqual(Array.from(text('abd')));
  });

  it('drops trailing 0xFF bytes before raising', () => {
    expect(Array.from(prefixEnd(bytes(0x61, 0xff, 0xff)))).toEqual([0x62]);
    expect(Array.from(prefixEnd(bytes(0x61, 0x62, 0xff)))).toEqual([0x61, 0x63]);
  });

  it('reaches the end of the key space for nothing or 0xFF only', () => {
    expect(Array.from(prefixEnd(new Uint8Array()))).toEqual([0]);
    expect(Array.from(prefixEnd(bytes(0xff, 0xff)))).toEqual([0]);
  });

  it('does not change what it was given', () => {
    const prefix = text('ab');
    prefixEnd(prefix);
    expect(Array.from(prefix)).toEqual(Array.from(text('ab')));
  });

  it('sorts after every key under the prefix and before the next sibling', () => {
    const end = prefixEnd(text('/app/'));
    const compare = (a: Uint8Array, b: Uint8Array): number =>
      Buffer.compare(Buffer.from(a), Buffer.from(b));
    expect(compare(text('/app/zzzz'), end)).toBeLessThan(0);
    expect(compare(text('/app0'), end)).toBeGreaterThanOrEqual(0);
    expect(compare(text('/app'), end)).toBeLessThan(0);
  });
});

describe('afterKey, startsWith and concatBytes', () => {
  it('adds a zero byte', () => {
    expect(Array.from(afterKey(text('a')))).toEqual([0x61, 0]);
    expect(Array.from(afterKey(new Uint8Array()))).toEqual([0]);
  });

  it('tells a prefix from a longer name and from a different one', () => {
    expect(startsWith(text('/a/b'), text('/a/'))).toBe(true);
    expect(startsWith(text('/a/'), text('/a/'))).toBe(true);
    expect(startsWith(text('/a'), text('/a/'))).toBe(false);
    expect(startsWith(text('/b/x'), text('/a/'))).toBe(false);
    expect(startsWith(text('x'), new Uint8Array())).toBe(true);
  });

  it('joins parts', () => {
    expect(Array.from(concatBytes(text('a'), new Uint8Array(), text('bc')))).toEqual(
      Array.from(text('abc')),
    );
    expect(concatBytes()).toHaveLength(0);
  });
});

describe('numbers of the gateway', () => {
  it('reads decimal strings and numbers, and zero for the rest', () => {
    expect(count('12')).toBe(12);
    expect(count(7)).toBe(7);
    expect(count('-1')).toBe(-1);
    expect(count(undefined)).toBe(0);
    expect(count('x')).toBe(0);
    expect(count(Number.NaN)).toBe(0);
  });

  it('keeps a 64-bit id as text', () => {
    expect(int64('7587862219395031808')).toBe('7587862219395031808');
    expect(int64('-5')).toBe('-5');
    expect(int64(42)).toBe('42');
    expect(int64(undefined)).toBe('0');
    expect(int64('0x10')).toBe('0');
    expect(int64(1.5)).toBe('0');
  });
});

describe('entryOf', () => {
  it('reads a full entry', () => {
    const entry = entryOf({
      key: toBase64(text('/k')),
      value: toBase64(text('v')),
      create_revision: '3',
      mod_revision: '9',
      version: '4',
      lease: '7587862219395031808',
    });
    expect(Buffer.from(entry.key).toString()).toBe('/k');
    expect(Buffer.from(entry.value).toString()).toBe('v');
    expect(entry.createRevision).toBe('3');
    expect(entry.modRevision).toBe('9');
    expect(entry.version).toBe(4);
    expect(entry.lease).toBe('7587862219395031808');
  });

  it('fills what the gateway leaves out because it is zero', () => {
    const entry = entryOf({ key: toBase64(text('/k')), create_revision: '2', mod_revision: '2' });
    expect(entry.value).toHaveLength(0);
    expect(entry.version).toBe(0);
    expect(entry.lease).toBe('0');
  });

  it('survives something that is not an entry', () => {
    expect(entryOf(undefined).key).toHaveLength(0);
    expect(entryOf('x').modRevision).toBe('0');
    expect(entryOf(null).lease).toBe('0');
  });
});
