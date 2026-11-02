// Time for LogQL queries (V13.25): the window a query looks at and the nanosecond stamps Loki
// uses. A stamp is a `bigint` of nanoseconds since the epoch, so no digit is lost to a double.

import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';

export const NS_PER_MS = 1_000_000n;
const UNIT_MS: Readonly<Record<string, number>> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/** `90s`, `1h30m`, `7d`, `500ms` → milliseconds; undefined for anything else. */
export function parseDuration(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^(\d+(?:ms|s|m|h|d|w))+$/u.test(trimmed)) {
    return undefined;
  }
  let total = 0;
  for (const part of trimmed.matchAll(/(\d+)(ms|s|m|h|d|w)/gu)) {
    total += Number(part[1]) * (UNIT_MS[part[2] ?? ''] ?? 0);
  }
  return total > 0 ? total : undefined;
}

export function nowNs(now: Date): bigint {
  return BigInt(now.getTime()) * NS_PER_MS;
}

/**
 * A point in time as the user writes it: `now`, `now-1h`, an RFC 3339 time, or a number of
 * seconds, milliseconds, microseconds or nanoseconds since the epoch (told apart by size).
 */
export function parseInstant(text: string, now: Date): bigint | undefined {
  const value = text.trim();
  const relative = /^now(?:\s*-\s*(.+))?$/iu.exec(value);
  if (relative !== null) {
    if (relative[1] === undefined) {
      return nowNs(now);
    }
    const ms = parseDuration(relative[1]);
    return ms === undefined ? undefined : nowNs(now) - BigInt(ms) * NS_PER_MS;
  }
  if (/^\d+$/u.test(value)) {
    const digits = value.length;
    if (digits <= 11) {
      return BigInt(value) * 1_000_000_000n;
    }
    if (digits <= 14) {
      return BigInt(value) * NS_PER_MS;
    }
    if (digits <= 17) {
      return BigInt(value) * 1000n;
    }
    return BigInt(value);
  }
  if (/^\d+\.\d+$/u.test(value)) {
    const [whole = '0', fraction = ''] = value.split('.');
    return BigInt(whole) * 1_000_000_000n + BigInt(fraction.slice(0, 9).padEnd(9, '0'));
  }
  if (/^\d{4}-\d{2}-\d{2}/u.test(value)) {
    const fraction = /\.(\d{1,9})(?=Z|[+-]\d{2}:?\d{2}$|$)/u.exec(value)?.[1];
    const ms = Date.parse(value.replace(/\.\d+/u, ''));
    if (Number.isNaN(ms)) {
      return undefined;
    }
    const extra = fraction === undefined ? 0n : BigInt(fraction.padEnd(9, '0'));
    return BigInt(ms) * NS_PER_MS + extra;
  }
  return undefined;
}

export interface Window {
  readonly startNs: bigint;
  readonly endNs: bigint;
}

export interface WindowRequest {
  /** How far back from the end: `1h`. */
  readonly range?: string;
  readonly start?: string;
  readonly end?: string;
}

/** The longest window a query may ask for here; Loki has its own, usually smaller, limit. */
export const MAX_RANGE_MS = 366 * 86_400_000;

/**
 * The window of a query: `end` is now unless given; `start` is given, or `range` before the
 * end. A start after the end is an error, not a silently empty answer.
 */
export function resolveWindow(
  request: WindowRequest,
  fallbackRange: string,
  now: Date = new Date(),
): Window {
  const endNs = request.end === undefined ? nowNs(now) : parseInstant(request.end, now);
  if (endNs === undefined) {
    throw new DbError('syntax', msg('"{0}" is not a time Loki understands', request.end ?? ''));
  }
  let startNs: bigint | undefined;
  if (request.start !== undefined) {
    startNs = parseInstant(request.start, now);
    if (startNs === undefined) {
      throw new DbError('syntax', msg('"{0}" is not a time Loki understands', request.start));
    }
  } else {
    const text = request.range ?? fallbackRange;
    const ms = parseDuration(text);
    if (ms === undefined || ms > MAX_RANGE_MS) {
      throw new DbError(
        'syntax',
        msg('"{0}" is not a range of time: write it like 15m, 1h or 7d', text),
      );
    }
    startNs = endNs - BigInt(ms) * NS_PER_MS;
  }
  if (startNs >= endNs) {
    throw new DbError('syntax', msg('The start of the time range is not before its end'));
  }
  return { startNs, endNs };
}

/** `2026-11-02T10:00:00.123Z`: the stamp at the precision of a JavaScript date. */
export function isoOf(ns: bigint): string {
  return new Date(Number(ns / NS_PER_MS)).toISOString();
}
