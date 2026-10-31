// Reaching a server through a proxy (V10.2.5): a SOCKS5 proxy (RFC 1928, with the
// user and password of RFC 1929) or an HTTP proxy's CONNECT. What comes back is a
// plain socket to the server, so a driver, a TLS handshake or an SSH login can run
// over it as if it had connected directly. The server's name goes to the proxy, which
// looks it up itself: names inside a private network resolve there.

import { connect, isIP, type Socket } from 'node:net';
import { DbError, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';

export type ProxyKind = 'socks5' | 'http';

export interface ProxySpec {
  readonly kind: ProxyKind;
  readonly host: string;
  readonly port: number;
  readonly user?: string;
  readonly password?: string;
}

/** The longest a proxy answer may be before it is taken for something else. */
const MAX_HTTP_HEADER_BYTES = 16 * 1024;

/** A message about the proxy, whole sentences naming it (D100). */
type Say = (host: string, port: number) => string;

const SOCKS_REPLIES: Readonly<Record<number, Say>> = {
  1: (host, port) => msg('The proxy {0}:{1} failed', host, port),
  2: (host, port) => msg('The proxy {0}:{1} does not allow this connection', host, port),
  3: (host, port) => msg('The network cannot be reached from the proxy {0}:{1}', host, port),
  4: (host, port) => msg('The host cannot be reached from the proxy {0}:{1}', host, port),
  5: (host, port) => msg('The server refused the connection from the proxy {0}:{1}', host, port),
  6: (host, port) => msg('The connection timed out at the proxy {0}:{1}', host, port),
  7: (host, port) => msg('The proxy {0}:{1} does not support CONNECT', host, port),
  8: (host, port) => msg('The proxy {0}:{1} does not support this kind of address', host, port),
};

const NOT_SOCKS: Say = (host, port) => msg('The proxy {0}:{1} does not speak SOCKS5', host, port);
const WANTS_LOGIN: Say = (host, port) =>
  msg('The proxy {0}:{1} wants a user and password', host, port);

function failed(proxy: ProxySpec, say: Say, cause?: unknown): DbError {
  return new DbError(
    'connection-failed',
    say(proxy.host, proxy.port),
    cause === undefined ? undefined : { cause },
  );
}

function unreachable(proxy: ProxySpec, error: unknown): DbError {
  return failed(
    proxy,
    (host, port) => msg('Cannot reach the proxy {0}:{1}: {2}', host, port, errorMessage(error)),
    error,
  );
}

/** Reads from a socket on demand, keeping what arrived past the end of an answer. */
class Incoming {
  private buffered = Buffer.alloc(0);
  private waiting: (() => void) | undefined;
  private ended: Error | undefined;

  constructor(private readonly socket: Socket) {
    socket.on('data', this.onData);
    socket.on('end', this.onEnd);
    socket.on('error', this.onError);
  }

  /** Waits for at least `count` bytes and takes exactly that many. */
  async take(count: number): Promise<Buffer> {
    while (this.buffered.length < count) {
      await this.more();
    }
    const taken = this.buffered.subarray(0, count);
    this.buffered = this.buffered.subarray(count);
    return taken;
  }

  /** Takes bytes up to and including `marker`, refusing to wait past `limit` bytes. */
  async takeUntil(marker: string, limit: number): Promise<Buffer> {
    for (;;) {
      const at = this.buffered.indexOf(marker);
      if (at !== -1) {
        return await this.take(at + marker.length);
      }
      if (this.buffered.length > limit) {
        throw new Error('answer too long');
      }
      await this.more();
    }
  }

  /** Stops listening, and puts back what was read ahead for whoever reads next. */
  detach(): void {
    // Paused, so nothing flows past before the next reader (a pipe) resumes it.
    this.socket.pause();
    this.socket.off('data', this.onData);
    this.socket.off('end', this.onEnd);
    this.socket.off('error', this.onError);
    if (this.buffered.length > 0) {
      this.socket.unshift(this.buffered);
    }
  }

  private async more(): Promise<void> {
    if (this.ended !== undefined) {
      throw this.ended;
    }
    await new Promise<void>((resolve) => {
      this.waiting = resolve;
    });
    // Read through a call: the field may have been set while this waited.
    const ended = this.failure();
    if (ended !== undefined && this.buffered.length === 0) {
      throw ended;
    }
  }

  private failure(): Error | undefined {
    return this.ended;
  }

  private readonly onData = (chunk: Buffer): void => {
    this.buffered = Buffer.concat([this.buffered, chunk]);
    this.wake();
  };

  private readonly onEnd = (): void => {
    this.ended ??= new Error('the proxy closed the connection');
    this.wake();
  };

  private readonly onError = (error: Error): void => {
    this.ended ??= error;
    this.wake();
  };

  private wake(): void {
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.();
  }
}

/** The address part of a SOCKS5 request: an IP as bytes, else the name. */
function socksAddress(host: string): Buffer {
  const family = isIP(host);
  if (family === 4) {
    return Buffer.from([1, ...host.split('.').map(Number)]);
  }
  if (family === 6) {
    const groups = expandIpv6(host);
    return Buffer.concat([
      Buffer.from([4]),
      ...groups.map((group) => {
        const bytes = Buffer.alloc(2);
        bytes.writeUInt16BE(group);
        return bytes;
      }),
    ]);
  }
  const name = Buffer.from(host, 'utf8');
  if (name.length > 255) {
    throw new Error('host name too long');
  }
  return Buffer.concat([Buffer.from([3, name.length]), name]);
}

/** The eight groups of an IPv6 address, `::` filled in. */
function expandIpv6(host: string): number[] {
  const [head = '', tail] = host.split('::');
  const parse = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => Number.parseInt(group, 16));
  const left = parse(head);
  const right = tail === undefined ? [] : parse(tail);
  return [...left, ...new Array<number>(8 - left.length - right.length).fill(0), ...right];
}

async function socksHandshake(
  socket: Socket,
  incoming: Incoming,
  proxy: ProxySpec,
  host: string,
  port: number,
): Promise<void> {
  const login = proxy.user !== undefined && proxy.user !== '';
  // Offer "no login" always; "user and password" too when there is a user.
  socket.write(Buffer.from(login ? [5, 2, 0, 2] : [5, 1, 0]));
  const [version, method] = await incoming.take(2);
  if (version !== 5) {
    throw failed(proxy, NOT_SOCKS);
  }
  if (method === 0xff) {
    throw failed(
      proxy,
      login
        ? (host, port) => msg('The proxy {0}:{1} accepts none of the ways to sign in', host, port)
        : WANTS_LOGIN,
    );
  }
  if (method === 2) {
    if (!login) {
      throw failed(proxy, WANTS_LOGIN);
    }
    const user = Buffer.from(proxy.user ?? '', 'utf8');
    const password = Buffer.from(proxy.password ?? '', 'utf8');
    if (user.length > 255 || password.length > 255) {
      throw failed(proxy, (host, port) =>
        msg('The user or password is too long for the SOCKS5 proxy {0}:{1}', host, port),
      );
    }
    socket.write(
      Buffer.concat([
        Buffer.from([1, user.length]),
        user,
        Buffer.from([password.length]),
        password,
      ]),
    );
    const [, status] = await incoming.take(2);
    if (status !== 0) {
      throw new DbError(
        'auth-failed',
        msg('The user or password of the proxy {0}:{1} is wrong', proxy.host, proxy.port),
      );
    }
  } else if (method !== 0) {
    throw failed(proxy, (host, port) =>
      msg('The proxy {0}:{1} asks for a way to sign in DataNest does not know', host, port),
    );
  }
  const portBytes = Buffer.alloc(2);
  portBytes.writeUInt16BE(port);
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), socksAddress(host), portBytes]));
  const [replyVersion, reply, , type] = await incoming.take(4);
  if (replyVersion !== 5) {
    throw failed(proxy, NOT_SOCKS);
  }
  if (reply !== 0) {
    throw failed(proxy, SOCKS_REPLIES[reply ?? 1] ?? SOCKS_REPLIES[1] ?? NOT_SOCKS);
  }
  // The address the proxy connected from, which nothing here needs: skipped.
  const length =
    type === 1 ? 4 : type === 4 ? 16 : type === 3 ? ((await incoming.take(1))[0] ?? 0) : -1;
  if (length < 0) {
    throw failed(proxy, (host, port) =>
      msg('The answer of the proxy {0}:{1} is not SOCKS5', host, port),
    );
  }
  await incoming.take(length + 2);
}

async function httpConnect(
  socket: Socket,
  incoming: Incoming,
  proxy: ProxySpec,
  host: string,
  port: number,
): Promise<void> {
  const authority = isIP(host) === 6 ? `[${host}]:${port}` : `${host}:${port}`;
  const login =
    proxy.user === undefined || proxy.user === ''
      ? []
      : [
          `Proxy-Authorization: Basic ${Buffer.from(`${proxy.user}:${proxy.password ?? ''}`, 'utf8').toString('base64')}`,
        ];
  socket.write(
    [`CONNECT ${authority} HTTP/1.1`, `Host: ${authority}`, ...login, '', ''].join('\r\n'),
  );
  let head: string;
  try {
    head = (await incoming.takeUntil('\r\n\r\n', MAX_HTTP_HEADER_BYTES)).toString('latin1');
  } catch (error) {
    throw unreachable(proxy, error);
  }
  const status = /^HTTP\/1\.[01] (\d{3})/u.exec(head)?.[1];
  if (status === undefined) {
    throw failed(proxy, (host, port) =>
      msg('The answer of the proxy {0}:{1} is not HTTP', host, port),
    );
  }
  if (status === '407') {
    throw new DbError(
      'auth-failed',
      login.length === 0
        ? WANTS_LOGIN(proxy.host, proxy.port)
        : msg('The user or password of the proxy {0}:{1} is wrong', proxy.host, proxy.port),
    );
  }
  if (!status.startsWith('2')) {
    const line = head.split('\r\n')[0] ?? '';
    throw failed(proxy, (host, port) =>
      msg('The proxy {0}:{1} answered {2}', host, port, line.slice(9).trim()),
    );
  }
}

/** A socket to `host:port` through the proxy; fails within `timeoutMs`. */
export async function connectThroughProxy(
  proxy: ProxySpec,
  host: string,
  port: number,
  timeoutMs: number,
): Promise<Socket> {
  const socket = connect({ host: proxy.host, port: proxy.port });
  socket.setNoDelay(true);
  const incoming = new Incoming(socket);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        failed(proxy, (host, port) =>
          msg(
            'The proxy {0}:{1} did not answer within {2} s',
            host,
            port,
            Math.round(timeoutMs / 1000),
          ),
        ),
      );
    }, timeoutMs);
  });
  let refused: ((error: Error) => void) | undefined;
  try {
    const connected = new Promise<void>((resolve, reject) => {
      refused = reject;
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const handshake = async (): Promise<void> => {
      await connected;
      await (proxy.kind === 'socks5'
        ? socksHandshake(socket, incoming, proxy, host, port)
        : httpConnect(socket, incoming, proxy, host, port));
    };
    await Promise.race([handshake(), timeout]);
    incoming.detach();
    return socket;
  } catch (error) {
    incoming.detach();
    socket.destroy();
    if (error instanceof DbError) {
      throw error;
    }
    throw unreachable(proxy, error);
  } finally {
    clearTimeout(timer);
    if (refused !== undefined) {
      socket.off('error', refused);
    }
  }
}
