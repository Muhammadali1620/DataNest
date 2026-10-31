import { describe, expect, it, vi } from 'vitest';
import { type HttpGet, OnlineTools, PUBLIC_IP_HOSTS } from '../../../../src/services/tools/online';

const ok = (body: string) => Promise.resolve({ status: 200, body });

describe('publicIp', () => {
  it('asks both services, each over https', async () => {
    const get = vi.fn<HttpGet>((url) =>
      ok(url.includes('api6') ? '2001:db8::1\n' : '203.0.113.7\n'),
    );
    const result = await new OnlineTools(get).publicIp();
    expect(result).toEqual({ ipv4: '203.0.113.7', ipv6: '2001:db8::1' });
    expect(get.mock.calls.map((call) => call[0]).sort()).toEqual([
      `https://${PUBLIC_IP_HOSTS.v4}/`,
      `https://${PUBLIC_IP_HOSTS.v6}/`,
    ]);
  });

  it('is fine without IPv6, which many networks lack', async () => {
    const get: HttpGet = (url) =>
      url.includes('api6')
        ? Promise.reject(Object.assign(new Error('x'), { code: 'ENETUNREACH' }))
        : ok('198.51.100.2');
    expect(await new OnlineTools(get).publicIp()).toEqual({ ipv4: '198.51.100.2' });
  });

  it('reports the IPv4 error when nothing answers', async () => {
    const timeout: HttpGet = () =>
      Promise.reject(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }));
    expect(await new OnlineTools(timeout).publicIp()).toEqual({ error: 'timeout' });
    const gone: HttpGet = () =>
      Promise.reject(Object.assign(new Error('x'), { code: 'ENOTFOUND' }));
    expect(await new OnlineTools(gone).publicIp()).toEqual({ error: 'not-found' });
  });

  it('does not trust a body that is no address, or a bad status', async () => {
    const html: HttpGet = () => ok('<html>captive portal</html>');
    expect(await new OnlineTools(html).publicIp()).toEqual({ error: 'failed' });
    const server: HttpGet = () => Promise.resolve({ status: 503, body: '203.0.113.7' });
    expect(await new OnlineTools(server).publicIp()).toEqual({ error: 'failed' });
    const swapped: HttpGet = (url) => ok(url.includes('api6') ? '203.0.113.7' : '2001:db8::1');
    expect(await new OnlineTools(swapped).publicIp()).toEqual({ error: 'failed' });
  });
});

describe('dohLookup', () => {
  const answer = JSON.stringify({
    Status: 0,
    Answer: [{ name: 'x.test.', type: 1, TTL: 30, data: '192.0.2.1' }],
  });

  it('sends the question to the chosen provider and reads the answer', async () => {
    const get = vi.fn<HttpGet>(() => ok(answer));
    const found = await new OnlineTools(get).dohLookup('x.test', 'A', 'cloudflare');
    expect(found).toEqual({ records: [{ name: 'x.test', type: 'A', ttl: 30, data: '192.0.2.1' }] });
    expect(get).toHaveBeenCalledWith(
      'https://cloudflare-dns.com/dns-query?name=x.test&type=A',
      { Accept: 'application/dns-json' },
      expect.any(Number),
    );
    await new OnlineTools(get).dohLookup('x.test', 'MX', 'google');
    expect(get.mock.calls[1]?.[0]).toBe('https://dns.google/resolve?name=x.test&type=MX');
  });

  it('refuses a host that is no host, before it asks anyone', async () => {
    const get = vi.fn<HttpGet>(() => ok(answer));
    expect(await new OnlineTools(get).dohLookup('bad host!', 'A', 'google')).toEqual({
      records: [],
      error: 'invalid-host',
    });
    expect(get).not.toHaveBeenCalled();
  });

  it('turns a bad status, an NXDOMAIN and a network error into a code', async () => {
    const status: HttpGet = () => Promise.resolve({ status: 500, body: '' });
    expect(await new OnlineTools(status).dohLookup('x.test', 'A', 'google')).toEqual({
      records: [],
      error: 'failed',
    });
    const nx: HttpGet = () => ok(JSON.stringify({ Status: 3 }));
    expect(await new OnlineTools(nx).dohLookup('x.test', 'A', 'google')).toEqual({
      records: [],
      error: 'not-found',
    });
    const down: HttpGet = () =>
      Promise.reject(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }));
    expect(await new OnlineTools(down).dohLookup('x.test', 'A', 'google')).toEqual({
      records: [],
      error: 'refused',
    });
  });
});
