import { connect, type Socket } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { openProxyTunnel } from '../../../../src/services/proxy/proxy-tunnel';
import type { Tunnel } from '../../../../src/services/tunnels';
import { RecordingLogger } from '../../../helpers/fakes';
import {
  startEchoServer,
  startHttpProxy,
  startSocksProxy,
  type TestProxy,
} from '../../../helpers/proxy-servers';

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).reverse()) {
    await step();
  }
});

async function server<T extends TestProxy>(started: Promise<T>): Promise<T> {
  const value = await started;
  cleanup.push(() => value.close());
  return value;
}

async function tunnel(
  proxyPort: number,
  kind: 'socks5' | 'http',
  targetPort: number,
): Promise<Tunnel> {
  const opened = await openProxyTunnel(
    {
      proxy: { kind, host: '127.0.0.1', port: proxyPort },
      target: { host: '127.0.0.1', port: targetPort },
      timeoutMs: 5000,
    },
    new RecordingLogger(),
  );
  cleanup.push(() => opened.close());
  return opened;
}

function talk(port: number, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket: Socket = connect({ host: '127.0.0.1', port });
    let received = '';
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString();
      if (received.length >= text.length) {
        socket.destroy();
        resolve(received);
      }
    });
    socket.on('error', reject);
    socket.on('close', () => {
      resolve(received);
    });
    socket.write(text);
  });
}

describe('openProxyTunnel', () => {
  it.each(['socks5', 'http'] as const)(
    'forwards each local connection through a %s proxy',
    async (kind) => {
      const echo = await server(startEchoServer());
      const proxy = await server(kind === 'socks5' ? startSocksProxy() : startHttpProxy());
      const opened = await tunnel(proxy.port, kind, echo.port);
      // Sent before the proxy has connected: held, not lost.
      expect(await talk(opened.port, 'first')).toBe('first');
      expect(await talk(opened.port, 'second')).toBe('second');
      expect(proxy.requests).toHaveLength(2);
      expect(opened.forwardError()).toBeUndefined();
    },
  );

  it('remembers why the last forwarded connection failed', async () => {
    const proxy = await server(startSocksProxy({ reply: 5 }));
    const opened = await tunnel(proxy.port, 'socks5', 1);
    expect(await talk(opened.port, 'x')).toBe('');
    expect(opened.forwardError()?.message).toMatch(/refused the connection/u);
  });

  it('closes its port and the connections through it', async () => {
    const echo = await server(startEchoServer());
    const proxy = await server(startSocksProxy());
    const opened = await tunnel(proxy.port, 'socks5', echo.port);
    await opened.close();
    await opened.closed;
    await expect(talk(opened.port, 'late')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});
