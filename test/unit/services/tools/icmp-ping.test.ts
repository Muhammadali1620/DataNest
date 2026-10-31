import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IcmpPing } from '../../../../src/services/tools/icmp-ping';
import type { PingLine } from '../../../../src/shared/tools/icmp';

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly kill = vi.fn(() => {
    this.emit('close', null);
    return true;
  });
}

function start(platform: NodeJS.Platform = 'linux') {
  const child = new FakeChild();
  const spawn = vi.fn((_file: string, _args: string[]): ChildProcess => {
    return child as unknown as ChildProcess;
  });
  return { ping: new IcmpPing(platform, spawn), child, spawn };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('IcmpPing.run', () => {
  it('runs the system ping with an argument list and streams every line', async () => {
    const { ping, child, spawn } = start();
    const lines: PingLine[] = [];
    const done = ping.run(1, 'example.com', 3, 2000, (line) => lines.push(line));
    expect(spawn).toHaveBeenCalledWith('ping', ['-n', '-c', '3', '-W', '2', 'example.com']);
    child.stdout.write(
      'PING example.com (1.2.3.4) 56(84) bytes of data.\n64 bytes from 1.2.3.4: icmp_seq=1 ttl=57 ti',
    );
    child.stdout.write('me=11.5 ms\n64 bytes from 1.2.3.4: icmp_seq=2 ttl=57 time=13 ms\r\n\n');
    child.stderr.write('ping: warning\n');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 0);
    const result = await done;
    expect(lines.map((line) => line.reply)).toEqual([false, true, true, false]);
    expect(lines[1]).toMatchObject({
      text: '64 bytes from 1.2.3.4: icmp_seq=1 ttl=57 time=11.5 ms',
      ms: 11.5,
    });
    expect(result).toEqual({
      available: true,
      attempts: [{ ok: true, ms: 11.5 }, { ok: true, ms: 13 }, { ok: false }],
    });
  });

  it('counts requests that got no reply as lost', async () => {
    const { ping, child } = start();
    const done = ping.run(2, '10.0.0.9', 2, 500, () => undefined);
    child.emit('close', 1);
    expect(await done).toEqual({ available: true, attempts: [{ ok: false }, { ok: false }] });
  });

  it('keeps a last line that has no newline', async () => {
    const { ping, child } = start();
    const lines: PingLine[] = [];
    const done = ping.run(3, 'h.test', 1, 500, (line) => lines.push(line));
    child.stdout.write('Request timed out.');
    await new Promise((resolve) => setImmediate(resolve));
    child.emit('close', 1);
    await done;
    expect(lines.map((line) => line.text)).toEqual(['Request timed out.']);
  });

  it('says the program is missing when it cannot be started', async () => {
    const { ping, child } = start();
    const done = ping.run(4, 'h.test', 2, 500, () => undefined);
    child.emit('error', Object.assign(new Error('spawn ping ENOENT'), { code: 'ENOENT' }));
    expect(await done).toEqual({ available: false, attempts: [] });
  });

  it('treats a throwing spawn as a missing program too', async () => {
    const ping = new IcmpPing('linux', () => {
      throw new Error('EACCES');
    });
    expect(await ping.run(5, 'h.test', 1, 500, () => undefined)).toEqual({
      available: false,
      attempts: [],
    });
  });

  it('does not report an error other than ENOENT as missing', async () => {
    const { ping, child } = start();
    const done = ping.run(6, 'h.test', 1, 500, () => undefined);
    child.emit('error', Object.assign(new Error('boom'), { code: 'EPERM' }));
    expect(await done).toEqual({ available: true, attempts: [{ ok: false }] });
  });

  it('refuses an invalid host without starting anything', async () => {
    const { ping, spawn } = start();
    for (const host of ['-c 1000000', 'a b', '', 'x;rm -rf /']) {
      expect(await ping.run(7, host, 1, 500, () => undefined)).toEqual({
        available: true,
        attempts: [],
        error: 'invalid-host',
      });
    }
    expect(spawn).not.toHaveBeenCalled();
  });

  it('clamps the count and the timeout to what the page allows', async () => {
    const { ping, child, spawn } = start('win32');
    const done = ping.run(8, 'h.test', 5000, 99_999_999, () => undefined);
    expect(spawn).toHaveBeenCalledWith('ping', ['-n', '10', '-w', '10000', 'h.test']);
    child.emit('close', 0);
    expect((await done).attempts).toHaveLength(10);
  });

  it('stops a run on request and when it runs too long', async () => {
    const { ping, child } = start();
    const first = ping.run(9, 'h.test', 2, 500, () => undefined);
    ping.cancel(9);
    expect(child.kill).toHaveBeenCalledOnce();
    expect((await first).available).toBe(true);
    ping.cancel(12345);

    vi.useFakeTimers();
    const second = start();
    const hung = second.ping.run(10, 'h.test', 1, 1000, () => undefined);
    await vi.advanceTimersByTimeAsync(5000);
    expect(second.child.kill).toHaveBeenCalled();
    await hung;
  });

  it('stops everything on dispose', async () => {
    const { ping, child } = start();
    const done = ping.run(11, 'h.test', 1, 500, () => undefined);
    ping.dispose();
    expect(child.kill).toHaveBeenCalled();
    await done;
  });
});
