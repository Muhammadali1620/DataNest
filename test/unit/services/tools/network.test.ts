import { createServer, type Server } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type Connect,
  NetworkTools,
  networkErrorOf,
  realConnect,
  type NetworkDeps,
} from '../../../../src/services/tools/network';

function tools(over: Partial<NetworkDeps> = {}): NetworkTools {
  return new NetworkTools({
    connect: () => Promise.resolve({ ok: true, ms: 12.34 }),
    lookup: () => Promise.resolve([{ address: '127.0.0.1', family: 4 }]),
    interfaces: () => ({}),
    now: () => 0,
    ...over,
  });
}

describe('networkErrorOf', () => {
  it.each([
    ['ECONNREFUSED', 'refused'],
    ['ETIMEDOUT', 'timeout'],
    ['ENOTFOUND', 'not-found'],
    ['EHOSTUNREACH', 'unreachable'],
    ['ENETUNREACH', 'unreachable'],
    ['EPIPE', 'failed'],
  ])('maps %s to %s', (code, expected) => {
    expect(networkErrorOf({ code })).toBe(expected);
  });

  it('is "failed" for anything without a code', () => {
    expect(networkErrorOf(new Error('x'))).toBe('failed');
    expect(networkErrorOf(undefined)).toBe('failed');
    expect(networkErrorOf('text')).toBe('failed');
  });
});

describe('interfaces', () => {
  it('flattens, sorts external IPv4 first and skips interfaces without addresses', () => {
    const list = tools({
      interfaces: () => ({
        lo: [
          {
            address: '127.0.0.1',
            family: 'IPv4',
            mac: '00:00',
            internal: true,
            cidr: '127.0.0.1/8',
            netmask: '',
            scopeid: undefined,
          } as never,
        ],
        eth0: [
          {
            address: 'fe80::1',
            family: 'IPv6',
            mac: 'aa',
            internal: false,
            cidr: null,
            netmask: '',
            scopeid: 0,
          } as never,
          {
            address: '192.168.1.5',
            family: 'IPv4',
            mac: 'aa',
            internal: false,
            cidr: '192.168.1.5/24',
            netmask: '',
            scopeid: undefined,
          } as never,
        ],
        empty: undefined,
      }),
    }).interfaces();
    expect(list.map((item) => item.address)).toEqual(['192.168.1.5', 'fe80::1', '127.0.0.1']);
    expect(list[0]).toMatchObject({ name: 'eth0', cidr: '192.168.1.5/24' });
    expect(list[1]).not.toHaveProperty('cidr');
  });

  it('is empty without interfaces', () => {
    expect(tools().interfaces()).toEqual([]);
  });
});

describe('portCheck', () => {
  it('reports an open port with its time rounded to a tenth', async () => {
    expect(await tools().portCheck('example.com', 80, 1000)).toEqual({ open: true, ms: 12.3 });
  });

  it('passes the checked host, the port and a clamped timeout to the connection', async () => {
    const connect = vi.fn<Connect>(() => Promise.resolve({ ok: true, ms: 1 }));
    await tools({ connect }).portCheck(' [::1] ', 5432, 1);
    expect(connect).toHaveBeenCalledWith('::1', 5432, 100);
    await tools({ connect }).portCheck('a.b', 80, 999_999);
    expect(connect).toHaveBeenLastCalledWith('a.b', 80, 10_000);
  });

  it('reports why a connection failed', async () => {
    const closed = tools({ connect: () => Promise.resolve({ ok: false, error: 'refused' }) });
    expect(await closed.portCheck('localhost', 9, 500)).toEqual({ open: false, error: 'refused' });
    const odd = tools({ connect: () => Promise.resolve({ ok: false }) });
    expect(await odd.portCheck('localhost', 9, 500)).toEqual({ open: false, error: 'failed' });
  });

  it('refuses a bad host or port without connecting', async () => {
    const connect = vi.fn<Connect>();
    const t = tools({ connect });
    expect(await t.portCheck('bad host', 80, 500)).toEqual({ open: false, error: 'invalid-host' });
    expect(await t.portCheck('localhost', 0, 500)).toEqual({ open: false, error: 'invalid-port' });
    expect(await t.portCheck('localhost', 70_000, 500)).toEqual({
      open: false,
      error: 'invalid-port',
    });
    expect(connect).not.toHaveBeenCalled();
  });
});

describe('dnsLookup', () => {
  it('returns the addresses', async () => {
    const t = tools({
      lookup: () =>
        Promise.resolve([
          { address: '93.184.216.34', family: 4 },
          { address: '2606:2800::1', family: 6 },
        ]),
    });
    expect(await t.dnsLookup('example.com')).toEqual({
      addresses: [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800::1', family: 6 },
      ],
    });
  });

  it('maps a failure and an empty answer', async () => {
    const missing = tools({
      lookup: () => Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' })),
    });
    expect(await missing.dnsLookup('nope.invalid')).toEqual({ addresses: [], error: 'not-found' });
    const empty = tools({ lookup: () => Promise.resolve([]) });
    expect(await empty.dnsLookup('nothing.test')).toEqual({ addresses: [], error: 'not-found' });
    const odd = tools({ lookup: () => Promise.resolve([{ address: 'x', family: 0 }]) });
    expect((await odd.dnsLookup('odd.test')).error).toBe('not-found');
    const broken = tools({ lookup: () => Promise.reject(new Error('boom')) });
    expect((await broken.dnsLookup('x.test')).error).toBe('failed');
  });

  it('refuses a bad host without asking', async () => {
    const lookup = vi.fn();
    expect(await tools({ lookup }).dnsLookup('bad host')).toEqual({
      addresses: [],
      error: 'invalid-host',
    });
    expect(lookup).not.toHaveBeenCalled();
  });
});

describe('tcpPing', () => {
  it('connects the asked number of times, one after another', async () => {
    let running = 0;
    let most = 0;
    const connect: Connect = async () => {
      running += 1;
      most = Math.max(most, running);
      await Promise.resolve();
      running -= 1;
      return { ok: true, ms: 5 };
    };
    const result = await tools({ connect }).tcpPing('localhost', 80, 3, 500);
    expect(result.attempts).toHaveLength(3);
    expect(most).toBe(1);
  });

  it('keeps the failures among the attempts', async () => {
    const answers = [
      { ok: true, ms: 4.44 },
      { ok: false, error: 'timeout' as const },
    ];
    const connect: Connect = () => Promise.resolve(answers.shift() ?? { ok: false });
    const result = await tools({ connect }).tcpPing('localhost', 80, 3, 500);
    expect(result.attempts).toEqual([
      { ok: true, ms: 4.4 },
      { ok: false, error: 'timeout' },
      { ok: false, error: 'failed' },
    ]);
  });

  it('caps the count and refuses bad input', async () => {
    const connect = vi.fn<Connect>(() => Promise.resolve({ ok: true, ms: 1 }));
    expect((await tools({ connect }).tcpPing('localhost', 80, 500, 500)).attempts).toHaveLength(10);
    const t = tools({ connect: vi.fn<Connect>() });
    expect(await t.tcpPing('', 80, 3, 500)).toEqual({ attempts: [], error: 'invalid-host' });
    expect(await t.tcpPing('localhost', 0, 3, 500)).toEqual({
      attempts: [],
      error: 'invalid-port',
    });
  });
});

// The real connection, against a server of this test on the loopback interface only.
describe('realConnect', () => {
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      if (server === undefined) {
        resolve();
      } else {
        server.close(() => {
          resolve();
        });
      }
    });
    server = undefined;
  });

  async function listen(): Promise<number> {
    server = createServer((socket) => {
      socket.destroy();
    });
    await new Promise<void>((resolve) => {
      server?.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    return typeof address === 'object' && address !== null ? address.port : 0;
  }

  it('connects to a listening port and measures the time', async () => {
    const port = await listen();
    const result = await realConnect('127.0.0.1', port, 2000);
    expect(result.ok).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
  });

  it('reports a closed port as refused', async () => {
    const port = await listen();
    await new Promise<void>((resolve) => {
      server?.close(() => {
        resolve();
      });
    });
    server = undefined;
    expect(await realConnect('127.0.0.1', port, 2000)).toEqual({ ok: false, error: 'refused' });
  });
});
