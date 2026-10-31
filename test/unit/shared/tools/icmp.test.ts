import { describe, expect, it } from 'vitest';
import { parsePingLine, pingArgs } from '../../../../src/shared/tools/icmp';

describe('pingArgs', () => {
  it('Linux: numeric output, count, wait in whole seconds, host last', () => {
    expect(pingArgs('linux', 'example.com', 4, 2500)).toEqual({
      file: 'ping',
      args: ['-n', '-c', '4', '-W', '3', 'example.com'],
    });
    expect(pingArgs('linux', '1.1.1.1', 1, 100).args).toContain('1');
  });

  it('macOS: wait in milliseconds, and ping6 for an IPv6 address', () => {
    expect(pingArgs('darwin', '8.8.8.8', 3, 2000)).toEqual({
      file: 'ping',
      args: ['-n', '-c', '3', '-W', '2000', '8.8.8.8'],
    });
    expect(pingArgs('darwin', '::1', 3, 2000).file).toBe('ping6');
  });

  it('Windows: -n count and -w milliseconds', () => {
    expect(pingArgs('win32', 'example.com', 4, 3000)).toEqual({
      file: 'ping',
      args: ['-n', '4', '-w', '3000', 'example.com'],
    });
  });

  it('puts the host last, so nothing after it can be taken for an option', () => {
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      expect(pingArgs(platform, 'h.test', 2, 1000).args.at(-1)).toBe('h.test');
    }
  });
});

describe('parsePingLine', () => {
  it('reads Linux and macOS replies', () => {
    expect(parsePingLine('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms')).toEqual({
      text: '64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=12.3 ms',
      reply: true,
      ms: 12.3,
    });
    expect(parsePingLine('64 bytes from ::1: icmp_seq=0 hlim=64 time=0.052 ms')).toMatchObject({
      reply: true,
      ms: 0.052,
    });
  });

  it('reads Windows replies, with the time under a millisecond', () => {
    expect(parsePingLine('Reply from 1.1.1.1: bytes=32 time=12ms TTL=57')).toMatchObject({
      reply: true,
      ms: 12,
    });
    expect(parsePingLine('Reply from 127.0.0.1: bytes=32 time<1ms TTL=128')).toMatchObject({
      reply: true,
      ms: 1,
    });
  });

  it('reads a reply in the system language', () => {
    expect(parsePingLine('Ответ от 8.8.8.8: число байт=32 время=12мс TTL=57')).toMatchObject({
      reply: true,
      ms: 12,
    });
    expect(parsePingLine('Antwort von 8.8.8.8: Bytes=32 Zeit=9ms TTL=57')).toMatchObject({
      reply: true,
      ms: 9,
    });
  });

  it('reads a decimal comma', () => {
    expect(parsePingLine('64 bytes from 1.1.1.1: icmp_seq=1 ttl=57 time=1,5 ms').ms).toBe(1.5);
  });

  it('treats everything else as plain output', () => {
    for (const text of [
      'PING example.com (93.184.216.34) 56(84) bytes of data.',
      'Request timed out.',
      'Request timeout for icmp_seq 0',
      '--- example.com ping statistics ---',
      '4 packets transmitted, 4 received, 0% packet loss, time 3004ms',
      'rtt min/avg/max/mdev = 11.1/12.2/13.3/0.5 ms',
      'ping: unknown host nope.invalid',
      '',
    ]) {
      expect(parsePingLine(text).reply, text).toBe(false);
    }
  });

  it('drops trailing space but keeps the text', () => {
    expect(parsePingLine('Request timed out.   \r').text).toBe('Request timed out.');
  });
});
