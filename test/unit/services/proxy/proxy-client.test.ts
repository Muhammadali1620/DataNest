import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { connectThroughProxy, type ProxySpec } from '../../../../src/services/proxy/proxy-client';
import {
  startEchoServer,
  startHttpProxy,
  startSocksProxy,
  type TestProxy,
} from '../../../helpers/proxy-servers';

const running: TestProxy[] = [];
const sockets: Socket[] = [];

async function track<T extends TestProxy>(server: Promise<T>): Promise<T> {
  const started = await server;
  running.push(started);
  return started;
}

afterEach(async () => {
  vi.useRealTimers();
  for (const socket of sockets.splice(0)) {
    socket.destroy();
  }
  for (const server of running.splice(0)) {
    await server.close();
  }
});

/** Writes a line through the socket and reads what comes back. */
async function roundTrip(socket: Socket, text: string, expected = text): Promise<string> {
  sockets.push(socket);
  let received = '';
  socket.resume();
  const done = new Promise<void>((resolve) => {
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
      if (received.length >= expected.length) {
        resolve();
      }
    });
  });
  socket.write(text);
  await done;
  return received;
}

function spec(kind: ProxySpec['kind'], port: number, extra: Partial<ProxySpec> = {}): ProxySpec {
  return { kind, host: '127.0.0.1', port, ...extra };
}

describe.each(['socks5', 'http'] as const)('connectThroughProxy over %s', (kind) => {
  const start = kind === 'socks5' ? startSocksProxy : startHttpProxy;

  it('reaches the server through the proxy, by name', async () => {
    const echo = await track(startEchoServer());
    const proxy = await track(start());
    const socket = await connectThroughProxy(spec(kind, proxy.port), 'localhost', echo.port, 5000);
    expect(await roundTrip(socket, 'ping')).toBe('ping');
    expect(proxy.requests).toEqual([`localhost:${echo.port}`]);
  });

  it('signs in with a user and password', async () => {
    const echo = await track(startEchoServer());
    const proxy = await track(start({ user: 'me', password: 'pässword' }));
    const socket = await connectThroughProxy(
      spec(kind, proxy.port, { user: 'me', password: 'pässword' }),
      '127.0.0.1',
      echo.port,
      5000,
    );
    expect(await roundTrip(socket, 'hello')).toBe('hello');
  });

  it('says when the password is wrong, as a sign-in failure', async () => {
    const echo = await track(startEchoServer());
    const proxy = await track(start({ user: 'me', password: 'right' }));
    await expect(
      connectThroughProxy(
        spec(kind, proxy.port, { user: 'me', password: 'wrong' }),
        '127.0.0.1',
        echo.port,
        5000,
      ),
    ).rejects.toMatchObject({
      code: 'auth-failed',
      message: expect.stringMatching(/wrong/u) as unknown,
    });
  });

  it('says when the proxy wants a user and none was given', async () => {
    const echo = await track(startEchoServer());
    const proxy = await track(start({ user: 'me', password: 'x' }));
    await expect(
      connectThroughProxy(spec(kind, proxy.port), '127.0.0.1', echo.port, 5000),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/wants a user and password/u) as unknown,
    });
  });

  it('keeps what the server sent right after the proxy answered', async () => {
    const echo = await track(startEchoServer('WELCOME'));
    const proxy = await track(start());
    const socket = await connectThroughProxy(spec(kind, proxy.port), '127.0.0.1', echo.port, 5000);
    expect(await roundTrip(socket, 'x', 'WELCOMEx')).toBe('WELCOMEx');
  });

  it('refuses an answer that is not of its protocol', async () => {
    const proxy = await track(start({ garbage: Buffer.from('SSH-2.0-OpenSSH\r\n\r\n') }));
    await expect(
      connectThroughProxy(spec(kind, proxy.port), '127.0.0.1', 1, 5000),
    ).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringContaining(`127.0.0.1:${proxy.port}`) as unknown,
    });
  });

  it('says when it cannot reach the proxy at all', async () => {
    const closed = await startEchoServer();
    await closed.close();
    await expect(
      connectThroughProxy(spec(kind, closed.port), '127.0.0.1', 1, 5000),
    ).rejects.toMatchObject({
      code: 'connection-failed',
      message: expect.stringMatching(/Cannot reach the proxy/u) as unknown,
    });
  });

  it('gives up on a proxy that never answers', async () => {
    const proxy = await track(start({ silent: true }));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const attempt = connectThroughProxy(spec(kind, proxy.port), '127.0.0.1', 1, 3000);
    const failed = expect(attempt).rejects.toMatchObject({
      message: expect.stringMatching(/did not answer within 3 s/u) as unknown,
    });
    await vi.advanceTimersByTimeAsync(3001);
    await failed;
  });
});

describe('connectThroughProxy over socks5', () => {
  it.each([
    [2, /does not allow this connection/u],
    [4, /host cannot be reached/u],
    [5, /refused the connection/u],
    [8, /kind of address/u],
    [42, /failed/u],
  ])('tells what reply %i means', async (reply, message) => {
    const proxy = await track(startSocksProxy({ reply }));
    await expect(
      connectThroughProxy(spec('socks5', proxy.port), 'db.internal', 5432, 5000),
    ).rejects.toMatchObject({ message: expect.stringMatching(message) as unknown });
  });

  it('sends addresses as IPv4 and IPv6 bytes and names as names', async () => {
    const proxy = await track(startSocksProxy({ reply: 5 }));
    for (const host of ['10.1.2.3', '::1', 'db.example.com']) {
      await connectThroughProxy(spec('socks5', proxy.port), host, 3306, 5000).catch(
        () => undefined,
      );
    }
    expect(proxy.requests).toEqual([
      '10.1.2.3:3306',
      '0:0:0:0:0:0:0:1:3306',
      'db.example.com:3306',
    ]);
  });

  it('refuses a user name longer than SOCKS5 can carry', async () => {
    const proxy = await track(startSocksProxy({ user: 'u', password: 'p' }));
    await expect(
      connectThroughProxy(spec('socks5', proxy.port, { user: 'u'.repeat(300) }), 'h', 1, 5000),
    ).rejects.toMatchObject({ message: expect.stringMatching(/too long/u) as unknown });
  });
});

describe('connectThroughProxy over http', () => {
  it('reports a status other than success', async () => {
    const proxy = await track(startHttpProxy({ status: '403 Forbidden' }));
    await expect(
      connectThroughProxy(spec('http', proxy.port), 'db', 5432, 5000),
    ).rejects.toMatchObject({
      message: expect.stringMatching(/answered 403 Forbidden/u) as unknown,
    });
  });

  it('writes an IPv6 target in brackets', async () => {
    const proxy = await track(startHttpProxy({ status: '502 Bad Gateway' }));
    await connectThroughProxy(spec('http', proxy.port), '::1', 5432, 5000).catch(() => undefined);
    expect(proxy.requests).toEqual(['[::1]:5432']);
  });
});
