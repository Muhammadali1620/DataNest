// Small proxies for tests (V10.2.5): a SOCKS5 server (RFC 1928, user and password of
// RFC 1929) and an HTTP proxy that answers CONNECT. They relay to real servers, so a
// driver can be tested end to end through them; and they can be told to misbehave.

import { connect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';

export interface TestProxy {
  readonly port: number;
  /** `host:port` of every CONNECT the proxy was asked for. */
  readonly requests: string[];
  close(): Promise<void>;
}

export interface ProxyOptions {
  /** Wanted credentials; absent means anyone may connect. */
  readonly user?: string;
  readonly password?: string;
  /** SOCKS5: answer the CONNECT with this reply code instead of relaying. */
  readonly reply?: number;
  /** HTTP: answer CONNECT with this status line instead of relaying, e.g. `403 Forbidden`. */
  readonly status?: string;
  /** Send these bytes first instead of a proper answer. */
  readonly garbage?: Buffer;
  /** Accept the connection and never answer. */
  readonly silent?: boolean;
}

async function listen(server: Server, sockets: Set<Socket>): Promise<number> {
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
  });
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });
  return (server.address() as AddressInfo).port;
}

function closer(server: Server, sockets: Set<Socket>): () => Promise<void> {
  return async () => {
    for (const socket of sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  };
}

/** Reads exactly `count` bytes from a socket in paused mode. */
function reader(socket: Socket): (count: number) => Promise<Buffer> {
  let buffered = Buffer.alloc(0);
  let wake: (() => void) | undefined;
  socket.on('data', (chunk: Buffer) => {
    buffered = Buffer.concat([buffered, chunk]);
    wake?.();
  });
  return async (count) => {
    while (buffered.length < count) {
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
    const taken = buffered.subarray(0, count);
    buffered = buffered.subarray(count);
    return taken;
  };
}

function relay(client: Socket, host: string, port: number, ready: () => void): void {
  const upstream = connect({ host, port }, () => {
    ready();
    client.removeAllListeners('data');
    client.pipe(upstream).pipe(client);
  });
  upstream.on('error', () => client.destroy());
  client.on('close', () => upstream.destroy());
}

export async function startSocksProxy(options: ProxyOptions = {}): Promise<TestProxy> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const server = createServer((client) => {
    if (options.silent === true) {
      return;
    }
    if (options.garbage !== undefined) {
      client.write(options.garbage);
      return;
    }
    const read = reader(client);
    void (async () => {
      const [, count = 0] = await read(2);
      const methods = [...(await read(count))];
      const wantsLogin = options.user !== undefined;
      if (wantsLogin && !methods.includes(2)) {
        client.end(Buffer.from([5, 0xff]));
        return;
      }
      client.write(Buffer.from([5, wantsLogin ? 2 : 0]));
      if (wantsLogin) {
        const [, userLength = 0] = await read(2);
        const user = (await read(userLength)).toString();
        const [passwordLength = 0] = await read(1);
        const password = (await read(passwordLength)).toString();
        const ok = user === options.user && password === (options.password ?? '');
        client.write(Buffer.from([1, ok ? 0 : 1]));
        if (!ok) {
          client.end();
          return;
        }
      }
      const [, , , type] = await read(4);
      let host: string;
      if (type === 1) {
        host = [...(await read(4))].join('.');
      } else if (type === 4) {
        const bytes = await read(16);
        host = Array.from({ length: 8 }, (_, index) =>
          bytes.readUInt16BE(index * 2).toString(16),
        ).join(':');
      } else {
        const [length = 0] = await read(1);
        host = (await read(length)).toString();
      }
      const port = (await read(2)).readUInt16BE(0);
      requests.push(`${host}:${port}`);
      if (options.reply !== undefined) {
        client.end(Buffer.from([5, options.reply, 0, 1, 0, 0, 0, 0, 0, 0]));
        return;
      }
      relay(client, host, port, () => {
        client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
      });
    })();
  });
  const port = await listen(server, sockets);
  return { port, requests, close: closer(server, sockets) };
}

export async function startHttpProxy(options: ProxyOptions = {}): Promise<TestProxy> {
  const sockets = new Set<Socket>();
  const requests: string[] = [];
  const server = createServer((client) => {
    if (options.silent === true) {
      return;
    }
    if (options.garbage !== undefined) {
      client.write(options.garbage);
      return;
    }
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) {
        return;
      }
      client.off('data', onData);
      const [line = '', ...headers] = head.slice(0, end).split('\r\n');
      const target = line.split(' ')[1] ?? '';
      requests.push(target);
      if (options.user !== undefined) {
        const expected = `Basic ${Buffer.from(`${options.user}:${options.password ?? ''}`).toString('base64')}`;
        const given = headers.find((header) =>
          header.toLowerCase().startsWith('proxy-authorization:'),
        );
        if (given?.slice(given.indexOf(':') + 1).trim() !== expected) {
          client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
          return;
        }
      }
      if (options.status !== undefined) {
        client.end(`HTTP/1.1 ${options.status}\r\n\r\n`);
        return;
      }
      const at = target.lastIndexOf(':');
      const host = target.slice(0, at).replace(/^\[|\]$/gu, '');
      relay(client, host, Number(target.slice(at + 1)), () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      });
    };
    client.on('data', onData);
  });
  const port = await listen(server, sockets);
  return { port, requests, close: closer(server, sockets) };
}

/** A server that sends back what it gets, after an optional greeting. */
export async function startEchoServer(greeting?: string): Promise<TestProxy> {
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    if (greeting !== undefined) {
      socket.write(greeting);
    }
    socket.pipe(socket);
  });
  const port = await listen(server, sockets);
  return { port, requests: [], close: closer(server, sockets) };
}
