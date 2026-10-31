// Checks for the Tools page's network form. The host checks again before it connects.

export type Checked<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string };

export const MAX_HOST_LENGTH = 253;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 10_000;
export const MAX_PING_COUNT = 10;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/iu;

export function isIpv4(text: string): boolean {
  const parts = text.split('.');
  return (
    parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255)
  );
}

export function isIpv6(text: string): boolean {
  if (!/^[0-9a-f:.]+$/iu.test(text) || !text.includes(':') || text.includes(':::')) {
    return false;
  }
  const groups = text.split('::');
  if (groups.length > 2) {
    return false;
  }
  const parts = text.split(':').filter((part) => part !== '');
  const tail = parts.at(-1) ?? '';
  const hasV4 = tail.includes('.');
  if (hasV4 && !isIpv4(tail)) {
    return false;
  }
  const words = hasV4 ? parts.slice(0, -1) : parts;
  const count = words.length + (hasV4 ? 2 : 0);
  return (
    words.every((part) => /^[0-9a-f]{1,4}$/iu.test(part)) &&
    (groups.length === 2 ? count < 8 : count === 8)
  );
}

/** A host name, an IPv4 or an IPv6 address; surrounding space and `[ ]` around IPv6 are dropped. */
export function checkHost(text: string): Checked<string> {
  let host = text.trim();
  if (host === '') {
    return { ok: false, reason: 'empty' };
  }
  if (host.startsWith('[') && host.endsWith(']')) {
    host = host.slice(1, -1);
  }
  if (host.length > MAX_HOST_LENGTH) {
    return { ok: false, reason: 'too-long' };
  }
  if (isIpv6(host) || isIpv4(host)) {
    return { ok: true, value: host };
  }
  if (/^[\d.]+$/u.test(host)) {
    return { ok: false, reason: 'invalid' };
  }
  const labels = host.replace(/\.$/u, '').split('.');
  return labels.every((label) => LABEL.test(label))
    ? { ok: true, value: host }
    : { ok: false, reason: 'invalid' };
}

export function checkPort(text: string | number): Checked<number> {
  const clean = String(text).trim();
  if (clean === '') {
    return { ok: false, reason: 'empty' };
  }
  const port = Number(clean);
  return /^\d+$/u.test(clean) && port >= 1 && port <= 65_535
    ? { ok: true, value: port }
    : { ok: false, reason: 'invalid' };
}

export function clampTimeout(ms: number): number {
  return Number.isFinite(ms)
    ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(ms)))
    : MAX_TIMEOUT_MS;
}

export function clampCount(count: number): number {
  return Number.isFinite(count) ? Math.min(MAX_PING_COUNT, Math.max(1, Math.trunc(count))) : 4;
}
