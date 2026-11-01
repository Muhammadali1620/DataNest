import { describe, expect, it } from 'vitest';
import {
  clock,
  parseLeaseId,
  parseSeconds,
  secondsLeft,
  toneOf,
} from '../../../../../webview/src/apps/etcd-key/lease-view';

const lease = (ttl: number) => ({ id: '7587862219395031808', ttl, grantedTtl: 600 });

describe('secondsLeft', () => {
  it('counts down from the time the lease was read', () => {
    expect(secondsLeft(lease(100), 0)).toBe(100);
    expect(secondsLeft(lease(100), 999)).toBe(100);
    expect(secondsLeft(lease(100), 1000)).toBe(99);
    expect(secondsLeft(lease(100), 35_400)).toBe(65);
  });

  it('goes below zero once it has run out', () => {
    expect(secondsLeft(lease(5), 8000)).toBe(-3);
  });

  it('stays ended for a lease the cluster no longer knows', () => {
    expect(secondsLeft(lease(-1), 0)).toBe(-1);
    expect(secondsLeft(lease(-1), 60_000)).toBe(-1);
  });
});

describe('clock', () => {
  it('writes hours, minutes and seconds', () => {
    expect(clock(0)).toBe('00:00:00');
    expect(clock(59)).toBe('00:00:59');
    expect(clock(3661)).toBe('01:01:01');
  });

  it('writes the days apart', () => {
    expect(clock(86_400)).toBe('1d 00:00:00');
    expect(clock(2 * 86_400 + 3 * 3600 + 4 * 60 + 5)).toBe('2d 03:04:05');
  });

  it('does not go below zero and drops a fraction', () => {
    expect(clock(-5)).toBe('00:00:00');
    expect(clock(61.9)).toBe('00:01:01');
  });
});

describe('toneOf', () => {
  it('is green with time, amber in the last minute, red when over', () => {
    expect(toneOf(3600)).toBe('ok');
    expect(toneOf(61)).toBe('ok');
    expect(toneOf(60)).toBe('soon');
    expect(toneOf(1)).toBe('soon');
    expect(toneOf(0)).toBe('ended');
    expect(toneOf(-1)).toBe('ended');
  });
});

describe('what the user types', () => {
  it('reads a whole number of seconds, at least one', () => {
    expect(parseSeconds('30')).toBe(30);
    expect(parseSeconds(' 7 ')).toBe(7);
    expect(parseSeconds('0')).toBeUndefined();
    expect(parseSeconds('')).toBeUndefined();
    expect(parseSeconds('1.5')).toBeUndefined();
    expect(parseSeconds('-3')).toBeUndefined();
    expect(parseSeconds('10s')).toBeUndefined();
    expect(parseSeconds('12345678901')).toBeUndefined();
  });

  it('reads a lease id as decimal digits, and nothing else', () => {
    expect(parseLeaseId('7587862219395031808')).toBe('7587862219395031808');
    expect(parseLeaseId(' 42 ')).toBe('42');
    expect(parseLeaseId('0')).toBeUndefined();
    expect(parseLeaseId('')).toBeUndefined();
    expect(parseLeaseId('0x694d')).toBeUndefined();
    expect(parseLeaseId('-5')).toBeUndefined();
    expect(parseLeaseId('1'.repeat(21))).toBeUndefined();
  });
});
