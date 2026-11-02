// A ZooKeeper server in memory for the tests (V13.24): it listens on a TCP port and speaks the
// same binary protocol as the real one, for the requests the browser makes, over a tree of
// znodes with stats, ACLs, sequential nodes and the digest sign-in. The real server is the
// reference (the `zookeeper` integration group); this one only has to be as strict about the
// things a browser can get wrong: the order of the fields, versions, ACLs and paths.

import { createHash } from 'node:crypto';
import * as net from 'node:net';
import * as tls from 'node:tls';
import type { ZookeeperAcl, ZookeeperStat } from '../../src/drivers/zookeeper-driver';
import { JuteReader, JuteWriter } from '../../src/drivers/zookeeper/jute';
import { ZK } from '../../src/drivers/zookeeper/errors';
import { must } from './must';

const PERM = { read: 1, write: 2, create: 4, delete: 8, admin: 16, all: 31 } as const;

const OP = {
  create: 1,
  delete: 2,
  exists: 3,
  getData: 4,
  setData: 5,
  getAcl: 6,
  setAcl: 7,
  ping: 11,
  getChildren2: 12,
  auth: 100,
  closeSession: -11,
} as const;

export const CONTAINER_OWNER = (1n << 63n).toString();

export interface FakeNode {
  data: Buffer;
  acl: ZookeeperAcl[];
  czxid: bigint;
  mzxid: bigint;
  pzxid: bigint;
  ctime: number;
  mtime: number;
  version: number;
  cversion: number;
  aversion: number;
  ephemeralOwner: bigint;
  /** Counter for the sequential children. */
  sequence: number;
}

export interface FakeZookeeperOptions {
  /** The timeout the server grants, in milliseconds (default: what the client asks for). */
  readonly sessionTimeoutMs?: number;
  /** Answers the connect request with a timeout of 0, as a server that is not ready does. */
  readonly refuseSessions?: boolean;
  /** Replies with `readOnly: true` in the connect answer. */
  readonly readOnly?: boolean;
  /** Never answers requests (for the timeout tests); pings are still answered. */
  readonly silent?: boolean;
  /** Serves TLS with this certificate and key. */
  readonly tls?: { readonly cert: Buffer; readonly key: Buffer };
  /** Never answers the connect request. */
  readonly mute?: boolean;
  /** The version `srvr` reports; the default (absent) answers that the command is not allowed. */
  readonly version?: string;
}

/** `user:password` → the id of the digest scheme, `user:base64(sha1(user:password))`. */
export function digestId(user: string, password: string): string {
  const hash = createHash('sha1').update(`${user}:${password}`).digest('base64');
  return `${user}:${hash}`;
}

export class FakeZookeeper {
  readonly nodes = new Map<string, FakeNode>();
  /** Request types received, in order (pings excluded). */
  readonly requests: number[] = [];
  /** Digest credentials the clients signed in with, `user:password`, in order. */
  readonly logins: string[] = [];
  /** Users that may sign in: name → password; empty: nobody is checked. */
  readonly users = new Map<string, string>();
  connects = 0;
  /** Four-letter commands received. */
  fourLetterWords = 0;
  closedSessions = 0;
  silent: boolean;
  /** False: pings go unanswered, as on a link that has died quietly. */
  answerPings = true;
  /** Bytes to send instead of the connect answer (a server that is not ZooKeeper). */
  garbage: Buffer | undefined;
  private zxid = 0n;
  private readonly sockets = new Set<net.Socket>();
  private readonly server: net.Server | tls.Server;
  private nextSession = 0x1000000n;

  constructor(private readonly options: FakeZookeeperOptions = {}) {
    this.silent = options.silent === true;
    this.nodes.set(
      '/',
      this.blank(Buffer.alloc(0), [{ perms: PERM.all, scheme: 'world', id: 'anyone' }]),
    );
    this.server =
      options.tls === undefined
        ? net.createServer((socket) => {
            this.serve(socket);
          })
        : tls.createServer({ cert: options.tls.cert, key: options.tls.key }, (socket) => {
            this.serve(socket);
          });
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => {
      this.server.listen(0, '127.0.0.1', resolve);
    });
    return (this.server.address() as net.AddressInfo).port;
  }

  async stop(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  /** Drops every open connection, as a server that went down does. */
  dropAll(): void {
    for (const socket of this.sockets) {
      socket.destroy();
    }
  }

  /** Makes a znode (and the ones above it) without any check. */
  seed(
    path: string,
    data: string | Buffer = '',
    options: { ephemeralOwner?: bigint; acl?: ZookeeperAcl[] } = {},
  ): void {
    let at = '';
    for (const part of path.split('/').slice(1)) {
      at += `/${part}`;
      if (!this.nodes.has(at)) {
        this.nodes.set(
          at,
          this.blank(Buffer.alloc(0), [{ perms: PERM.all, scheme: 'world', id: 'anyone' }]),
        );
      }
    }
    const node = this.nodes.get(path);
    if (node === undefined) {
      return;
    }
    node.data = Buffer.from(data);
    if (options.ephemeralOwner !== undefined) {
      node.ephemeralOwner = options.ephemeralOwner;
    }
    if (options.acl !== undefined) {
      node.acl = options.acl;
    }
  }

  private blank(data: Buffer, acl: ZookeeperAcl[]): FakeNode {
    this.zxid += 1n;
    return {
      data,
      acl,
      czxid: this.zxid,
      mzxid: this.zxid,
      pzxid: this.zxid,
      ctime: 1_700_000_000_000 + Number(this.zxid) * 1000,
      mtime: 1_700_000_000_000 + Number(this.zxid) * 1000,
      version: 0,
      cversion: 0,
      aversion: 0,
      ephemeralOwner: 0n,
      sequence: 0,
    };
  }

  childrenOf(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    const names: string[] = [];
    for (const other of this.nodes.keys()) {
      if (other !== path && other.startsWith(prefix) && !other.slice(prefix.length).includes('/')) {
        names.push(other.slice(prefix.length));
      }
    }
    return names;
  }

  statOf(path: string): ZookeeperStat {
    const node = must(this.nodes.get(path));
    return {
      czxid: node.czxid.toString(),
      mzxid: node.mzxid.toString(),
      pzxid: node.pzxid.toString(),
      ctime: node.ctime,
      mtime: node.mtime,
      version: node.version,
      cversion: node.cversion,
      aversion: node.aversion,
      ephemeralOwner: BigInt.asUintN(64, node.ephemeralOwner).toString(),
      dataLength: node.data.length,
      numChildren: this.childrenOf(path).length,
    };
  }

  private serve(socket: net.Socket): void {
    this.sockets.add(socket);
    let received: Buffer = Buffer.alloc(0);
    let connected = false;
    const ids = new Set<string>();
    const send = (body: Buffer): void => {
      const head = Buffer.alloc(4);
      head.writeInt32BE(body.length);
      socket.write(Buffer.concat([head, body]));
    };
    const reply = (xid: number, code: number, body?: JuteWriter): void => {
      const writer = new JuteWriter().int(xid).long(this.zxid).int(code);
      send(Buffer.concat([writer.toBuffer(), body?.toBuffer() ?? Buffer.alloc(0)]));
    };
    socket.on('close', () => {
      this.sockets.delete(socket);
    });
    socket.on('error', () => undefined);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      if (!connected && received.subarray(0, 4).toString('latin1') === 'srvr') {
        this.fourLetterWords += 1;
        socket.end(
          this.options.version === undefined
            ? 'srvr is not executed because it is not in the whitelist.\n'
            : `Zookeeper version: ${this.options.version}-1234, built on 2024-01-01 00:00 UTC\nLatency min/avg/max: 0/0/0\n`,
        );
        return;
      }
      while (received.length >= 4) {
        const length = received.readInt32BE(0);
        if (received.length < 4 + length) {
          return;
        }
        const frame = received.subarray(4, 4 + length);
        received = received.subarray(4 + length);
        if (!connected) {
          connected = true;
          this.connects += 1;
          if (this.garbage !== undefined) {
            socket.write(this.garbage);
            continue;
          }
          if (this.options.mute === true) {
            continue;
          }
          const request = new JuteReader(Buffer.from(frame));
          request.int();
          request.long();
          const asked = request.int();
          const timeout =
            this.options.refuseSessions === true ? 0 : (this.options.sessionTimeoutMs ?? asked);
          const answer = new JuteWriter()
            .int(0)
            .int(timeout)
            .long(this.nextSession)
            .bytes(Buffer.alloc(16))
            .bool(this.options.readOnly === true);
          this.nextSession += 1n;
          send(answer.toBuffer());
          continue;
        }
        this.handle(Buffer.from(frame), reply, ids, socket);
      }
    });
  }

  /** May the signed-in ids do `perm` on the node? */
  private allowed(node: FakeNode, perm: number, ids: ReadonlySet<string>): boolean {
    return node.acl.some((entry) => {
      if ((entry.perms & perm) === 0) {
        return false;
      }
      if (entry.scheme === 'world') {
        return true;
      }
      return entry.scheme === 'digest' && ids.has(entry.id);
    });
  }

  private handle(
    frame: Buffer,
    reply: (xid: number, code: number, body?: JuteWriter) => void,
    ids: Set<string>,
    socket: net.Socket,
  ): void {
    const reader = new JuteReader(frame);
    const xid = reader.int();
    const type = reader.int();
    if (type === OP.ping) {
      if (this.answerPings) {
        reply(-2, 0);
      }
      return;
    }
    this.requests.push(type);
    if (type === OP.closeSession) {
      this.closedSessions += 1;
      reply(xid, 0);
      socket.end();
      return;
    }
    if (this.silent) {
      return;
    }
    if (type === OP.auth) {
      reader.int();
      const scheme = reader.string();
      const secret = reader.bytes()?.toString('utf8') ?? '';
      const [user = '', ...rest] = secret.split(':');
      const password = rest.join(':');
      if (scheme !== 'digest' || (this.users.size > 0 && this.users.get(user) !== password)) {
        reply(-4, ZK.AUTH_FAILED);
        return;
      }
      this.logins.push(secret);
      ids.add(digestId(user, password));
      reply(-4, 0);
      return;
    }
    const path = reader.string();
    const node = this.nodes.get(path);
    const fail = (code: number): void => {
      reply(xid, code);
    };
    switch (type) {
      case OP.exists: {
        if (node === undefined) {
          fail(ZK.NO_NODE);
          return;
        }
        // As on the real server, the stat wants the read permission, too.
        if (!this.allowed(node, PERM.read, ids)) {
          fail(ZK.NO_AUTH);
          return;
        }
        reply(xid, 0, new JuteWriter().stat(this.statOf(path)));
        return;
      }
      case OP.getData: {
        if (node === undefined) {
          fail(ZK.NO_NODE);
          return;
        }
        if (!this.allowed(node, PERM.read, ids)) {
          fail(ZK.NO_AUTH);
          return;
        }
        reply(xid, 0, new JuteWriter().bytes(node.data).stat(this.statOf(path)));
        return;
      }
      case OP.getChildren2: {
        if (node === undefined) {
          fail(ZK.NO_NODE);
          return;
        }
        if (!this.allowed(node, PERM.read, ids)) {
          fail(ZK.NO_AUTH);
          return;
        }
        const names = this.childrenOf(path);
        const body = new JuteWriter().int(names.length);
        for (const name of names) {
          body.string(name);
        }
        reply(xid, 0, body.stat(this.statOf(path)));
        return;
      }
      case OP.getAcl: {
        if (node === undefined) {
          fail(ZK.NO_NODE);
          return;
        }
        if (!this.allowed(node, PERM.read | PERM.admin, ids)) {
          fail(ZK.NO_AUTH);
          return;
        }
        reply(xid, 0, new JuteWriter().acl(node.acl).stat(this.statOf(path)));
        return;
      }
      case OP.setAcl: {
        const acl = reader.aclList();
        const version = reader.int();
        if (node === undefined) {
          fail(ZK.NO_NODE);
          return;
        }
        if (!this.allowed(node, PERM.admin, ids)) {
          fail(ZK.NO_AUTH);
          return;
        }
        if (acl.length === 0) {
          fail(ZK.INVALID_ACL);
          return;
        }
        if (version !== -1 && version !== node.aversion) {
          fail(ZK.BAD_VERSION);
          return;
        }
        this.zxid += 1n;
        node.acl = acl;
        node.aversion += 1;
        reply(xid, 0, new JuteWriter().stat(this.statOf(path)));
        return;
      }
      case OP.setData: {
        const data = reader.bytes() ?? Buffer.alloc(0);
        const version = reader.int();
        if (node === undefined) {
          fail(ZK.NO_NODE);
          return;
        }
        if (!this.allowed(node, PERM.write, ids)) {
          fail(ZK.NO_AUTH);
          return;
        }
        if (version !== -1 && version !== node.version) {
          fail(ZK.BAD_VERSION);
          return;
        }
        this.zxid += 1n;
        node.data = data;
        node.version += 1;
        node.mzxid = this.zxid;
        node.mtime += 1000;
        reply(xid, 0, new JuteWriter().stat(this.statOf(path)));
        return;
      }
      case OP.delete: {
        const version = reader.int();
        if (node === undefined || path === '/') {
          fail(path === '/' ? ZK.BAD_ARGUMENTS : ZK.NO_NODE);
          return;
        }
        const parentPath = path.slice(0, path.lastIndexOf('/')) || '/';
        const parent = must(this.nodes.get(parentPath));
        if (!this.allowed(parent, PERM.delete, ids)) {
          fail(ZK.NO_AUTH);
          return;
        }
        if (version !== -1 && version !== node.version) {
          fail(ZK.BAD_VERSION);
          return;
        }
        if (this.childrenOf(path).length > 0) {
          fail(ZK.NOT_EMPTY);
          return;
        }
        this.zxid += 1n;
        this.nodes.delete(path);
        parent.cversion += 1;
        parent.pzxid = this.zxid;
        reply(xid, 0);
        return;
      }
      case OP.create: {
        const data = reader.bytes() ?? Buffer.alloc(0);
        const acl = reader.aclList();
        const flags = reader.int();
        const parentPath = path.slice(0, path.lastIndexOf('/')) || '/';
        const parent = this.nodes.get(parentPath);
        if (parent === undefined) {
          fail(ZK.NO_NODE);
          return;
        }
        if (
          parent.ephemeralOwner !== 0n &&
          parent.ephemeralOwner !== BigInt.asIntN(64, 1n << 63n)
        ) {
          fail(ZK.NO_CHILDREN_FOR_EPHEMERALS);
          return;
        }
        if (!this.allowed(parent, PERM.create, ids)) {
          fail(ZK.NO_AUTH);
          return;
        }
        let made = path;
        if ((flags & 2) !== 0) {
          made = `${path}${String(parent.sequence).padStart(10, '0')}`;
          parent.sequence += 1;
        }
        if (this.nodes.has(made)) {
          fail(ZK.NODE_EXISTS);
          return;
        }
        // The `auth` scheme stands for every id the client signed in with.
        const resolved = acl.flatMap((entry) =>
          entry.scheme === 'auth'
            ? [...ids].map((id) => ({ perms: entry.perms, scheme: 'digest', id }))
            : [entry],
        );
        if (resolved.length === 0) {
          fail(ZK.INVALID_ACL);
          return;
        }
        const created = this.blank(data, resolved);
        if ((flags & 4) !== 0) {
          created.ephemeralOwner = BigInt.asIntN(64, 1n << 63n);
        }
        this.nodes.set(made, created);
        parent.cversion += 1;
        parent.pzxid = this.zxid;
        reply(xid, 0, new JuteWriter().string(made));
        return;
      }
      default:
        fail(ZK.SYSTEM_ERROR);
    }
  }
}
