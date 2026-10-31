import { describe, expect, it } from 'vitest';
import { toolsProtocol } from '../../../../src/shared/protocols/tools';

const host = toolsProtocol.host;

describe('toolsProtocol', () => {
  it('accepts what the page asks and the host answers', () => {
    expect(host.requests.hash.params.parse({ text: 'x' })).toEqual({ text: 'x' });
    const hashes = { md5: 'a', sha1: 'b', sha256: 'c', bytes: 1 };
    expect(host.requests.hash.result.parse(hashes)).toEqual(hashes);
    expect(
      host.requests.portCheck.params.parse({ host: 'h', port: 80, timeoutMs: 500 }),
    ).toBeTruthy();
    expect(host.requests.portCheck.result.parse({ open: false, error: 'refused' })).toEqual({
      open: false,
      error: 'refused',
    });
    expect(
      host.requests.dnsLookup.result.parse({ addresses: [{ address: '::1', family: 6 }] }),
    ).toBeTruthy();
    expect(
      host.requests.tcpPing.result.parse({
        attempts: [
          { ok: true, ms: 1 },
          { ok: false, error: 'timeout' },
        ],
      }),
    ).toBeTruthy();
    expect(
      host.requests.interfaces.result.parse({
        items: [{ name: 'lo', address: '127.0.0.1', family: 'IPv4', mac: '00', internal: true }],
      }),
    ).toBeTruthy();
    expect(host.events.copyText.parse({ text: 'x' })).toEqual({ text: 'x' });
  });

  it('refuses ports, counts and timeouts out of range', () => {
    const base = { host: 'h', port: 80, timeoutMs: 500 };
    expect(() => host.requests.portCheck.params.parse({ ...base, port: 0 })).toThrow();
    expect(() => host.requests.portCheck.params.parse({ ...base, port: 65_536 })).toThrow();
    expect(() => host.requests.portCheck.params.parse({ ...base, port: 1.5 })).toThrow();
    expect(() => host.requests.portCheck.params.parse({ ...base, host: '' })).toThrow();
    expect(() => host.requests.tcpPing.params.parse({ ...base, count: 0 })).toThrow();
    expect(() => host.requests.tcpPing.params.parse({ ...base, count: 101 })).toThrow();
  });

  it('refuses unknown errors and families', () => {
    expect(() => host.requests.portCheck.result.parse({ open: false, error: 'weird' })).toThrow();
    expect(() =>
      host.requests.dnsLookup.result.parse({ addresses: [{ address: 'x', family: 5 }] }),
    ).toThrow();
  });

  it('limits what is saved', () => {
    const ok = { suggestedName: 'a.png', extension: 'png', base64: 'AAAA' };
    expect(host.requests.saveFile.params.parse(ok)).toEqual(ok);
    expect(() => host.requests.saveFile.params.parse({ ...ok, suggestedName: '' })).toThrow();
    expect(() =>
      host.requests.saveFile.params.parse({ ...ok, extension: 'toolongextension' }),
    ).toThrow();
  });
});
