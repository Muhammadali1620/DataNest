import { describe, expect, it } from 'vitest';
import {
  checkHost,
  checkPort,
  clampCount,
  clampTimeout,
  MAX_HOST_LENGTH,
  MAX_PING_COUNT,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from '../../../../src/shared/tools/validate';

describe('checkHost', () => {
  it.each([
    'localhost',
    'example.com',
    'a-b.c-d.example.org',
    'example.com.',
    '127.0.0.1',
    '255.255.255.255',
    '::1',
    '2001:db8::8a2e:370:7334',
    '1:2:3:4:5:6:7:8',
    '::ffff:192.168.0.1',
    '[::1]',
    '  host1  ',
  ])('accepts %j', (text) => {
    expect(checkHost(text).ok).toBe(true);
  });

  it('trims and unbrackets the value', () => {
    expect(checkHost(' [::1] ')).toEqual({ ok: true, value: '::1' });
    expect(checkHost(' Example.COM ')).toEqual({ ok: true, value: 'Example.COM' });
  });

  it.each([
    '',
    '   ',
    'bad host',
    '-start.com',
    'end-.com',
    'a..b',
    'under_score.com',
    '256.1.1.1',
    '1.2.3',
    ':::',
    '1:2:3',
    '12345::g',
  ])('refuses %j', (text) => {
    expect(checkHost(text).ok).toBe(false);
  });

  it('says why', () => {
    expect(checkHost('')).toEqual({ ok: false, reason: 'empty' });
    expect(checkHost('a'.repeat(MAX_HOST_LENGTH + 1))).toEqual({ ok: false, reason: 'too-long' });
    expect(checkHost('bad host')).toEqual({ ok: false, reason: 'invalid' });
  });

  it('refuses a label longer than 63 characters', () => {
    expect(checkHost(`${'a'.repeat(64)}.com`).ok).toBe(false);
    expect(checkHost(`${'a'.repeat(63)}.com`).ok).toBe(true);
  });
});

describe('checkPort', () => {
  it('accepts 1 to 65535, as text or a number', () => {
    expect(checkPort('3306')).toEqual({ ok: true, value: 3306 });
    expect(checkPort(1)).toEqual({ ok: true, value: 1 });
    expect(checkPort(' 65535 ')).toEqual({ ok: true, value: 65_535 });
  });

  it.each(['0', '65536', '-1', '12.5', '80a', '1e3', 'http'])('refuses %j', (text) => {
    expect(checkPort(text)).toEqual({ ok: false, reason: 'invalid' });
  });

  it('says when it is empty', () => {
    expect(checkPort('  ')).toEqual({ ok: false, reason: 'empty' });
  });
});

describe('limits', () => {
  it('clamps the timeout', () => {
    expect(clampTimeout(5)).toBe(MIN_TIMEOUT_MS);
    expect(clampTimeout(1e9)).toBe(MAX_TIMEOUT_MS);
    expect(clampTimeout(1500.4)).toBe(1500);
    expect(clampTimeout(Number.NaN)).toBe(MAX_TIMEOUT_MS);
  });

  it('clamps the count', () => {
    expect(clampCount(0)).toBe(1);
    expect(clampCount(500)).toBe(MAX_PING_COUNT);
    expect(clampCount(3.9)).toBe(3);
    expect(clampCount(Number.NaN)).toBe(4);
  });
});
