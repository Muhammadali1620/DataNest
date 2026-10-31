// Network probes of the Tools page: TCP connect, DNS lookup, the machine's interfaces.
// The operating system's calls are parameters, so the logic is tested without a network;
// `realNetwork` is what the extension uses. Nothing here talks to a service of ours or
// anyone's else but the host the user typed.

import { createConnection, type Socket } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { networkInterfaces } from 'node:os';
import type { InterfaceInfo, NetworkErrorCode } from '../../shared/protocols/tools';
import { clampCount, clampTimeout, checkHost, checkPort } from '../../shared/tools/validate';

export interface ProbeResult {
  readonly ok: boolean;
  readonly ms?: number;
  readonly error?: NetworkErrorCode;
}

/** One TCP connect to a host that was already checked. */
export type Connect = (host: string, port: number, timeoutMs: number) => Promise<ProbeResult>;

export interface NetworkDeps {
  readonly connect: Connect;
  readonly lookup: (host: string) => Promise<{ address: string; family: number }[]>;
  readonly interfaces: () => ReturnType<typeof networkInterfaces>;
  /** Milliseconds, fractions allowed. */
  readonly now: () => number;
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : undefined;
}

/** Maps a Node network error code to the few words the page knows. */
export function networkErrorOf(error: unknown): NetworkErrorCode {
  switch (codeOf(error)) {
    case 'ECONNREFUSED':
      return 'refused';
    case 'ETIMEDOUT':
    case 'ETIMEOUT':
      return 'timeout';
    case 'ENOTFOUND':
    case 'ENODATA':
    case 'ENOENT':
      return 'not-found';
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
    case 'EADDRNOTAVAIL':
      return 'unreachable';
    case undefined:
    default:
      return 'failed';
  }
}

export const realConnect: Connect = (host, port, timeoutMs) =>
  new Promise((resolve) => {
    const started = performance.now();
    // Created at once, so `finish` can always close it; the listeners come right after.
    const socket: Socket = createConnection({ host, port });
    let done = false;
    const finish = (result: ProbeResult): void => {
      if (done) {
        return;
      }
      done = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => {
      finish({ ok: true, ms: performance.now() - started });
    });
    socket.once('timeout', () => {
      finish({ ok: false, error: 'timeout' });
    });
    socket.once('error', (error) => {
      finish({ ok: false, error: networkErrorOf(error) });
    });
  });

export const realNetwork: NetworkDeps = {
  connect: realConnect,
  lookup: async (host) => await dnsLookup(host, { all: true }),
  interfaces: networkInterfaces,
  now: () => performance.now(),
};

const round1 = (value: number): number => Math.round(value * 10) / 10;

export class NetworkTools {
  constructor(private readonly deps: NetworkDeps = realNetwork) {}

  /** Every address of every interface, IPv4 first; interfaces without addresses are left out. */
  interfaces(): InterfaceInfo[] {
    const items: InterfaceInfo[] = [];
    for (const [name, list] of Object.entries(this.deps.interfaces())) {
      for (const entry of list ?? []) {
        items.push({
          name,
          address: entry.address,
          family: entry.family,
          mac: entry.mac,
          internal: entry.internal,
          ...(entry.cidr === null ? {} : { cidr: entry.cidr }),
        });
      }
    }
    return items.sort(
      (a, b) =>
        Number(a.internal) - Number(b.internal) ||
        a.family.localeCompare(b.family) ||
        a.name.localeCompare(b.name),
    );
  }

  async portCheck(
    host: string,
    port: number,
    timeoutMs: number,
  ): Promise<{ open: boolean; ms?: number; error?: NetworkErrorCode }> {
    const checkedHost = checkHost(host);
    if (!checkedHost.ok) {
      return { open: false, error: 'invalid-host' };
    }
    const checkedPort = checkPort(port);
    if (!checkedPort.ok) {
      return { open: false, error: 'invalid-port' };
    }
    const result = await this.deps.connect(
      checkedHost.value,
      checkedPort.value,
      clampTimeout(timeoutMs),
    );
    return result.ok
      ? { open: true, ...(result.ms === undefined ? {} : { ms: round1(result.ms) }) }
      : { open: false, error: result.error ?? 'failed' };
  }

  async dnsLookup(
    host: string,
  ): Promise<{ addresses: { address: string; family: 4 | 6 }[]; error?: NetworkErrorCode }> {
    const checked = checkHost(host);
    if (!checked.ok) {
      return { addresses: [], error: 'invalid-host' };
    }
    try {
      const found = await this.deps.lookup(checked.value);
      const addresses: { address: string; family: 4 | 6 }[] = [];
      for (const entry of found) {
        if (entry.family === 4 || entry.family === 6) {
          addresses.push({ address: entry.address, family: entry.family });
        }
      }
      return addresses.length === 0 ? { addresses, error: 'not-found' } : { addresses };
    } catch (error) {
      return { addresses: [], error: networkErrorOf(error) };
    }
  }

  /** Connects `count` times in a row, so the times do not disturb each other. */
  async tcpPing(
    host: string,
    port: number,
    count: number,
    timeoutMs: number,
  ): Promise<{ attempts: ProbeResult[]; error?: NetworkErrorCode }> {
    const checkedHost = checkHost(host);
    if (!checkedHost.ok) {
      return { attempts: [], error: 'invalid-host' };
    }
    const checkedPort = checkPort(port);
    if (!checkedPort.ok) {
      return { attempts: [], error: 'invalid-port' };
    }
    const attempts: ProbeResult[] = [];
    for (let i = 0; i < clampCount(count); i += 1) {
      const result = await this.deps.connect(
        checkedHost.value,
        checkedPort.value,
        clampTimeout(timeoutMs),
      );
      attempts.push(
        result.ok
          ? { ok: true, ...(result.ms === undefined ? {} : { ms: round1(result.ms) }) }
          : { ok: false, error: result.error ?? 'failed' },
      );
    }
    return { attempts };
  }
}
