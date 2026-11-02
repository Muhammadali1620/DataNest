// How the etcd key page (V13.19) words a lease: the time left, counted down between reads,
// and how soon the key will go, as a colour class.

import type { EtcdLease } from '../../../../src/shared/protocols/etcd-key';

export type LeaseTone = 'ok' | 'soon' | 'ended';

/** Seconds a lease has left `elapsedMs` after it was read; below zero it has ended. */
export function secondsLeft(lease: EtcdLease, elapsedMs: number): number {
  if (lease.ttl < 0) {
    return -1;
  }
  return lease.ttl - Math.floor(elapsedMs / 1000);
}

/** `2d 03:04:05`, `00:04:05`; the same clock as the Redis page shows a TTL. */
export function clock(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86_400);
  const time = [Math.floor((total % 86_400) / 3600), Math.floor((total % 3600) / 60), total % 60]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
  return days > 0 ? `${days}d ${time}` : time;
}

/** Green while there is time, amber in the last minute, red once it is over. */
export function toneOf(seconds: number): LeaseTone {
  if (seconds <= 0) {
    return 'ended';
  }
  return seconds <= 60 ? 'soon' : 'ok';
}

/** A whole number of seconds from what the user typed, or undefined. */
export function parseSeconds(text: string): number | undefined {
  const trimmed = text.trim();
  if (!/^\d{1,10}$/u.test(trimmed)) {
    return undefined;
  }
  const value = Number(trimmed);
  return value >= 1 ? value : undefined;
}

/** A lease id from what the user typed: decimal digits only (a hex id is not accepted). */
export function parseLeaseId(text: string): string | undefined {
  const trimmed = text.trim();
  return /^\d{1,20}$/u.test(trimmed) && trimmed !== '0' ? trimmed : undefined;
}

/** `14:03:09`: the time of day a change was seen, in the viewer's time zone. */
export function clockTime(at: number): string {
  const date = new Date(at);
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}
