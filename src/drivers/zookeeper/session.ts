// A ZooKeeper session over Node's own sockets (V13.24). The binary protocol ("jute") of the
// client port is small, and the browser needs a dozen requests, so it is spoken here and
// no client library is bundled (D154). One socket carries many requests at once: each has
// an `xid`, the server answers in order, and the answers are matched to the requests by it.
// A ping keeps the session alive; a session that hears nothing for its timeout is dropped.

import * as net from 'node:net';
import * as tls from 'node:tls';
import { DbError, errorMessage } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  DEFAULT_PORTS,
  effectivePort,
  type ResolvedConnectionConfig,
} from '../../shared/connection';
import { identityCheck, sniName, tlsFailure, tlsMaterial, type TlsMaterial } from '../common/tls';
import type {
  ZookeeperAcl,
  ZookeeperCreateMode,
  ZookeeperServerInfo,
  ZookeeperSession,
  ZookeeperStat,
} from '../zookeeper-driver';
import { networkFailure, ZK, zookeeperFailure } from './errors';
import { JuteReader, JuteWriter, MAX_FRAME_BYTES } from './jute';

/** The session timeout asked for, in milliseconds; the server may shorten or lengthen it. */
export const SESSION_TIMEOUT_MS = 15_000;

/** Milliseconds a request waits for its answer. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Request types of the protocol (`ZooDefs.OpCode`). */
const OP = {
  create: 1,
  delete: 2,
  exists: 3,
  getData: 4,
  setData: 5,
  getAcl: 6,
  ping: 11,
  getChildren2: 12,
  auth: 100,
  closeSession: -11,
} as const;

/** The `xid`s the server uses for answers that are not to a request of ours. */
const XID = { watch: -1, ping: -2, auth: -4 } as const;

const PERM_ALL = 31;
const OPEN_ACL: readonly ZookeeperAcl[] = [{ perms: PERM_ALL, scheme: 'world', id: 'anyone' }];
const CREATOR_ACL: readonly ZookeeperAcl[] = [{ perms: PERM_ALL, scheme: 'auth', id: '' }];

const FLAGS: Readonly<Record<ZookeeperCreateMode, number>> = {
  persistent: 0,
  sequential: 2,
  container: 4,
};

export interface ZookeeperEndpoint {
  readonly host: string;
  readonly port: number;
}

/** `a:2181,b` → `[{a,2181},{b,<port>}]`; blanks and repeats go. */
export function serversOf(host: string | undefined, port: number | undefined): ZookeeperEndpoint[] {
  const fallback = port ?? DEFAULT_PORTS.zookeeper ?? 2181;
  const seen = new Map<string, ZookeeperEndpoint>();
  for (const part of (host ?? 'localhost').split(',')) {
    const name = part.trim();
    if (name === '') {
      continue;
    }
    // `[::1]` and `[::1]:2182` are IPv6; a bare `host` takes the port box's value.
    const bracket = /^\[(.*)\](?::(\d+))?$/u.exec(name);
    const plain = /^([^:]+):(\d+)$/u.exec(name);
    const endpoint: ZookeeperEndpoint =
      bracket !== null
        ? {
            host: bracket[1] ?? name,
            port: bracket[2] === undefined ? fallback : Number(bracket[2]),
          }
        : plain !== null
          ? { host: plain[1] ?? name, port: Number(plain[2]) }
          : { host: name, port: fallback };
    seen.set(`${endpoint.host}:${endpoint.port}`, endpoint);
  }
  return seen.size === 0 ? [{ host: 'localhost', port: fallback }] : [...seen.values()];
}

/** The chroot of a connection: `/app/` and `app` both mean `/app`; none means the root. */
export function chrootOf(database: string | undefined): string {
  const trimmed = (database ?? '').trim().replace(/\/+$/u, '');
  if (trimmed === '') {
    return '';
  }
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

interface Pending {
  readonly path: string;
  readonly decode: (reader: JuteReader) => unknown;
  readonly missingOk: boolean;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ZookeeperTarget {
  readonly servers: readonly ZookeeperEndpoint[];
  readonly chroot: string;
  readonly user: string;
  readonly password: string;
  readonly tls?: TlsMaterial;
  readonly serverName: string;
  readonly connectTimeoutMs: number;
}

export function zookeeperTarget(
  config: ResolvedConnectionConfig,
  material: TlsMaterial | undefined,
): ZookeeperTarget {
  return {
    servers: serversOf(config.host, effectivePort(config)),
    chroot: chrootOf(config.database),
    user: config.user?.trim() ?? '',
    password: config.password ?? '',
    ...(material === undefined ? {} : { tls: material }),
    serverName: material?.serverName ?? config.host ?? 'localhost',
    connectTimeoutMs: (config.options?.connectTimeout ?? DEFAULT_CONNECT_TIMEOUT_SECONDS) * 1000,
  };
}

class ZookeeperConnection implements ZookeeperSession {
  server: ZookeeperServerInfo = {
    sessionId: '0',
    sessionTimeoutMs: SESSION_TIMEOUT_MS,
    readOnly: false,
    address: '',
  };

  private socket: net.Socket | undefined;
  private received: Buffer = Buffer.alloc(0);
  private readonly pending = new Map<number, Pending>();
  private xid = 0;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private lastHeard = Date.now();
  private closed = false;
  private failure: DbError | undefined;
  private onFrame: ((frame: Buffer) => void) | undefined;

  constructor(
    private readonly target: ZookeeperTarget,
    private readonly requestTimeoutMs: number,
  ) {}

  /** Connects to the first server that answers, and starts the session. */
  async open(): Promise<void> {
    let last: unknown;
    for (const endpoint of this.target.servers) {
      try {
        await this.openOn(endpoint);
        return;
      } catch (error) {
        last = error;
        this.dropSocket();
      }
    }
    throw last instanceof DbError ? last : networkFailure(last);
  }

  private async openOn(endpoint: ZookeeperEndpoint): Promise<void> {
    this.closed = false;
    this.failure = undefined;
    this.received = Buffer.alloc(0);
    const socket = await this.connect(endpoint);
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.take(chunk);
    });
    socket.on('error', (error) => {
      this.fail(this.describe(error));
    });
    socket.on('close', () => {
      this.fail(new DbError('connection-failed', msg('The connection to ZooKeeper was closed')));
    });
    const reply = await this.handshake();
    this.handshakeFailed = undefined;
    this.lastHeard = Date.now();
    reply.int(); // protocol version
    const timeout = reply.int();
    const sessionId = reply.long();
    reply.bytes();
    const readOnly = reply.remaining > 0 ? reply.bool() : false;
    if (timeout <= 0) {
      throw new DbError(
        'connection-failed',
        msg('ZooKeeper refused the session: the server is not ready or does not know it'),
      );
    }
    this.server = {
      sessionId: BigInt.asUintN(64, sessionId).toString(),
      sessionTimeoutMs: timeout,
      readOnly,
      address: `${endpoint.host}:${endpoint.port}`,
    };
    this.startPing();
    if (this.target.user !== '') {
      await this.authenticate();
    }
    if (this.target.chroot !== '') {
      const stat = await this.exists('/');
      if (stat === undefined) {
        throw new DbError(
          'not-found',
          msg('The chroot "{0}" does not exist on the server', this.target.chroot),
        );
      }
    }
  }

  private connect(endpoint: ZookeeperEndpoint): Promise<net.Socket> {
    return new Promise<net.Socket>((resolve, reject) => {
      const { tls: material } = this.target;
      let socket: net.Socket;
      const timer = setTimeout(() => {
        socket.destroy();
        reject(
          new DbError(
            'timeout',
            msg('Could not reach {0}:{1} in time', endpoint.host, endpoint.port),
          ),
        );
      }, this.target.connectTimeoutMs);
      const done = (): void => {
        clearTimeout(timer);
        socket.removeListener('error', failed);
        resolve(socket);
      };
      const failed = (error: Error): void => {
        clearTimeout(timer);
        socket.destroy();
        reject(this.describe(error));
      };
      if (material === undefined) {
        socket = net.connect({ host: endpoint.host, port: endpoint.port });
        socket.once('connect', done);
      } else {
        const servername = sniName(material.serverName);
        socket = tls.connect({
          host: endpoint.host,
          port: endpoint.port,
          ...(material.ca === undefined ? {} : { ca: [material.ca] }),
          ...(material.cert === undefined ? {} : { cert: material.cert }),
          ...(material.key === undefined ? {} : { key: material.key }),
          rejectUnauthorized: material.mode !== 'require',
          checkServerIdentity: identityCheck(material),
          ...(servername === undefined ? {} : { servername }),
        });
        socket.once('secureConnect', done);
      }
      socket.setNoDelay(true);
      socket.once('error', failed);
    });
  }

  private describe(error: unknown): DbError {
    return tlsFailure(error, this.target.serverName) ?? networkFailure(error);
  }

  /** Sends the connect request and returns the reader of the answer. */
  private handshake(): Promise<JuteReader> {
    return new Promise<JuteReader>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.onFrame = undefined;
        reject(new DbError('timeout', msg('ZooKeeper did not answer the connect request in time')));
      }, this.target.connectTimeoutMs);
      this.onFrame = (frame) => {
        clearTimeout(timer);
        this.onFrame = undefined;
        try {
          resolve(new JuteReader(frame));
        } catch (error) {
          reject(this.describe(error));
        }
      };
      const hold = (error: DbError): void => {
        clearTimeout(timer);
        reject(error);
      };
      this.handshakeFailed = hold;
      const request = new JuteWriter()
        .int(0) // protocol version
        .long(0n) // last zxid seen
        .int(SESSION_TIMEOUT_MS)
        .long(0n) // no session to resume
        .bytes(Buffer.alloc(16)) // its password
        .bool(false); // a read-only session is not wanted
      this.write(request.frame());
    });
  }

  private handshakeFailed: ((error: DbError) => void) | undefined;

  private async authenticate(): Promise<void> {
    const body = new JuteWriter()
      .int(0)
      .string('digest')
      .bytes(Buffer.from(`${this.target.user}:${this.target.password}`, 'utf8'));
    await this.send(XID.auth, OP.auth, body, () => undefined, '/', false);
  }

  private startPing(): void {
    const timeout = this.server.sessionTimeoutMs;
    const every = Math.max(250, Math.floor(timeout / 3));
    // A server that has said nothing for the whole timeout (and a few pings) has dropped us.
    const silentFor = Math.max(timeout, every * 3);
    this.pingTimer = setInterval(() => {
      if (this.closed) {
        return;
      }
      if (Date.now() - this.lastHeard > silentFor) {
        this.fail(
          new DbError(
            'connection-failed',
            msg(
              'ZooKeeper has not answered for {0} seconds: the session is dropped',
              Math.round(this.server.sessionTimeoutMs / 1000),
            ),
          ),
        );
        return;
      }
      const header = new JuteWriter().int(XID.ping).int(OP.ping);
      this.write(header.frame());
    }, every);
    this.pingTimer.unref();
  }

  private take(chunk: Buffer): void {
    this.received = this.received.length === 0 ? chunk : Buffer.concat([this.received, chunk]);
    for (;;) {
      if (this.received.length < 4) {
        return;
      }
      const length = this.received.readInt32BE(0);
      if (length < 0 || length > MAX_FRAME_BYTES) {
        this.fail(
          new DbError(
            'connection-failed',
            msg('The server did not answer as ZooKeeper does (a frame of {0} bytes)', length),
          ),
        );
        return;
      }
      if (this.received.length < 4 + length) {
        return;
      }
      const frame = Buffer.from(this.received.subarray(4, 4 + length));
      this.received = this.received.subarray(4 + length);
      this.lastHeard = Date.now();
      this.dispatch(frame);
    }
  }

  private dispatch(frame: Buffer): void {
    if (this.onFrame !== undefined) {
      this.onFrame(frame);
      return;
    }
    try {
      const reader = new JuteReader(frame);
      const xid = reader.int();
      reader.long(); // zxid
      const code = reader.int();
      if (xid === XID.ping || xid === XID.watch) {
        return;
      }
      const request = this.pending.get(xid);
      if (request === undefined) {
        return;
      }
      this.pending.delete(xid);
      clearTimeout(request.timer);
      if (code === ZK.NO_NODE && request.missingOk) {
        request.resolve(undefined);
      } else if (code !== 0) {
        request.reject(zookeeperFailure(code, request.path));
      } else {
        request.resolve(request.decode(reader));
      }
    } catch (error) {
      this.fail(
        new DbError(
          'internal',
          msg('ZooKeeper sent an answer that cannot be read: {0}', errorMessage(error)),
          {
            cause: error,
          },
        ),
      );
    }
  }

  private write(bytes: Buffer): void {
    const socket = this.socket;
    if (socket === undefined || socket.destroyed) {
      return;
    }
    socket.write(bytes);
  }

  private send<T>(
    xid: number,
    type: number,
    body: JuteWriter,
    decode: (reader: JuteReader) => T,
    path: string,
    missingOk: boolean,
  ): Promise<T> {
    if (this.closed || this.socket === undefined) {
      return Promise.reject(
        this.failure ?? new DbError('connection-failed', msg('The session is closed')),
      );
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(xid);
        reject(new DbError('timeout', msg('ZooKeeper did not answer "{0}" in time', path)));
      }, this.requestTimeoutMs);
      this.pending.set(xid, {
        path,
        decode,
        missingOk,
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
      });
      const header = new JuteWriter().int(xid).int(type);
      this.write(framed(header, body));
    });
  }

  private request<T>(
    type: number,
    body: JuteWriter,
    decode: (reader: JuteReader) => T,
    path: string,
    missingOk = false,
  ): Promise<T> {
    this.xid += 1;
    return this.send(this.xid, type, body, decode, path, missingOk);
  }

  /** The path on the server: below the chroot. */
  private absolute(path: string): string {
    if (this.target.chroot === '') {
      return path;
    }
    return path === '/' ? this.target.chroot : `${this.target.chroot}${path}`;
  }

  private relative(path: string): string {
    const { chroot } = this.target;
    if (chroot === '' || !path.startsWith(chroot)) {
      return path;
    }
    return path.slice(chroot.length) === '' ? '/' : path.slice(chroot.length);
  }

  async children(
    path: string,
  ): Promise<{ readonly names: readonly string[]; readonly stat: ZookeeperStat }> {
    return await this.request(
      OP.getChildren2,
      new JuteWriter().string(this.absolute(path)).bool(false),
      (reader) => ({ names: reader.stringList(), stat: reader.stat() }),
      path,
    );
  }

  async getData(
    path: string,
  ): Promise<{ readonly data: Uint8Array; readonly stat: ZookeeperStat }> {
    return await this.request(
      OP.getData,
      new JuteWriter().string(this.absolute(path)).bool(false),
      (reader) => ({ data: reader.bytes() ?? Buffer.alloc(0), stat: reader.stat() }),
      path,
    );
  }

  async exists(path: string): Promise<ZookeeperStat | undefined> {
    return await this.request(
      OP.exists,
      new JuteWriter().string(this.absolute(path)).bool(false),
      (reader) => reader.stat(),
      path,
      true,
    );
  }

  async getAcl(
    path: string,
  ): Promise<{ readonly acl: readonly ZookeeperAcl[]; readonly stat: ZookeeperStat }> {
    return await this.request(
      OP.getAcl,
      new JuteWriter().string(this.absolute(path)),
      (reader) => ({ acl: reader.aclList(), stat: reader.stat() }),
      path,
    );
  }

  async create(path: string, data: Uint8Array, mode: ZookeeperCreateMode): Promise<string> {
    // A connection that signed in makes nodes only its user may change; one that did not,
    // makes open ones.
    const acl = this.target.user === '' ? OPEN_ACL : CREATOR_ACL;
    const created = await this.request(
      OP.create,
      new JuteWriter().string(this.absolute(path)).bytes(data).acl(acl).int(FLAGS[mode]),
      (reader) => reader.string(),
      path,
    );
    return this.relative(created);
  }

  async setData(path: string, data: Uint8Array, version: number): Promise<ZookeeperStat> {
    return await this.request(
      OP.setData,
      new JuteWriter().string(this.absolute(path)).bytes(data).int(version),
      (reader) => reader.stat(),
      path,
    );
  }

  async remove(path: string, version: number): Promise<void> {
    await this.request(
      OP.delete,
      new JuteWriter().string(this.absolute(path)).int(version),
      () => undefined,
      path,
    );
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    const socket = this.socket;
    if (socket !== undefined && !socket.destroyed) {
      this.xid += 1;
      this.write(framed(new JuteWriter().int(this.xid).int(OP.closeSession), new JuteWriter()));
    }
    this.closed = true;
    this.stopPing();
    this.failPending(new DbError('connection-failed', msg('The session is closed')));
    if (socket !== undefined) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          socket.destroy();
          resolve();
        }, 1000);
        socket.once('close', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.end();
      });
    }
  }

  /** The link is gone: every request in flight fails, and later ones too. */
  private fail(error: DbError): void {
    this.handshakeFailed?.(error);
    this.handshakeFailed = undefined;
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.failure = error;
    this.stopPing();
    this.failPending(error);
    this.socket?.destroy();
  }

  private failPending(error: DbError): void {
    for (const [xid, request] of [...this.pending]) {
      this.pending.delete(xid);
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  private stopPing(): void {
    if (this.pingTimer !== undefined) {
      clearInterval(this.pingTimer);
      this.pingTimer = undefined;
    }
  }

  private dropSocket(): void {
    this.stopPing();
    this.socket?.removeAllListeners();
    this.socket?.on('error', () => undefined);
    this.socket?.destroy();
    this.socket = undefined;
    this.handshakeFailed = undefined;
    this.onFrame = undefined;
  }
}

/** A request on the wire: its length, the header, the body. */
function framed(header: JuteWriter, body: JuteWriter): Buffer {
  const all = Buffer.concat([header.toBuffer(), body.toBuffer()]);
  const length = Buffer.alloc(4);
  length.writeInt32BE(all.length);
  return Buffer.concat([length, all]);
}

export async function openZookeeperSession(
  config: ResolvedConnectionConfig,
): Promise<ZookeeperSession> {
  return await openZookeeperSessionWith(config, REQUEST_TIMEOUT_MS);
}

/** Like `openZookeeperSession`, with the time a request waits for its answer given (tests). */
export async function openZookeeperSessionWith(
  config: ResolvedConnectionConfig,
  requestTimeoutMs: number,
): Promise<ZookeeperSession> {
  const material = await tlsMaterial(config);
  const connection = new ZookeeperConnection(zookeeperTarget(config, material), requestTimeoutMs);
  try {
    await connection.open();
  } catch (error) {
    await connection.close().catch(() => undefined);
    throw error instanceof DbError ? error : networkFailure(error);
  }
  return connection;
}
