// A local port in front of a proxy (V10.2.5), like an SSH tunnel's: each connection a
// driver opens to 127.0.0.1:<port> goes on through the proxy to the database server.
// Drivers need no proxy support of their own, and TLS still runs end to end.

import { createServer, type Socket } from 'node:net';
import { DbError, errorMessage, toDbError } from '../../core/errors';
import type { Logger } from '../../core/logging/logger';
import { msg } from '../../core/user-message';
import type { Tunnel } from '../tunnels';
import { connectThroughProxy, type ProxySpec } from './proxy-client';

export interface ProxyTunnelSpec {
  readonly proxy: ProxySpec;
  readonly target: { readonly host: string; readonly port: number };
  readonly timeoutMs: number;
}

export async function openProxyTunnel(spec: ProxyTunnelSpec, logger: Logger): Promise<Tunnel> {
  const server = createServer();
  const sockets = new Set<Socket>();
  let failure: DbError | undefined;
  let closing = false;
  let resolveClosed: () => void = () => undefined;
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const shutdown = (): void => {
    if (closing) {
      return;
    }
    closing = true;
    server.close();
    for (const socket of sockets) {
      socket.destroy();
    }
    resolveClosed();
  };

  server.on('connection', (local) => {
    sockets.add(local);
    local.on('close', () => sockets.delete(local));
    local.on('error', () => local.destroy());
    // Hold what the driver sends until the proxy has connected.
    local.pause();
    void (async () => {
      try {
        const remote = await connectThroughProxy(
          spec.proxy,
          spec.target.host,
          spec.target.port,
          spec.timeoutMs,
        );
        if (local.destroyed) {
          remote.destroy();
          return;
        }
        failure = undefined;
        sockets.add(remote);
        remote.on('close', () => {
          sockets.delete(remote);
          local.destroy();
        });
        remote.on('error', () => remote.destroy());
        local.on('close', () => remote.destroy());
        local.pipe(remote).pipe(local);
      } catch (error) {
        failure = toDbError(error, 'connection-failed');
        logger.warn(failure.message);
        local.destroy();
      }
    })();
  });

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      // Only this machine may use the port: it leads on through the proxy.
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
  } catch (error) {
    shutdown();
    throw new DbError(
      'connection-failed',
      msg('Cannot open a local port: {0}', errorMessage(error)),
      { cause: error },
    );
  }
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  logger.info(
    `Proxy tunnel open on 127.0.0.1:${port} to ${spec.target.host}:${spec.target.port} through ${spec.proxy.kind} ${spec.proxy.host}:${spec.proxy.port}`,
  );
  return {
    port,
    closed,
    forwardError: () => failure,
    close: async () => {
      shutdown();
      await closed;
    },
  };
}
