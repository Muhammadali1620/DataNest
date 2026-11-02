// A ZooKeeper driver that opens sessions on a tree in memory without any socket (V13.24), for
// the tests of the connection manager and the commands. The wire protocol has its own tests
// (the session against `FakeZookeeper`, and the `zookeeper` integration group).

import { DbError } from '../../src/core/errors';
import type {
  ZookeeperAcl,
  ZookeeperCreateMode,
  ZookeeperDriver,
  ZookeeperServerInfo,
  ZookeeperSession,
  ZookeeperStat,
} from '../../src/drivers/zookeeper-driver';
import type { ResolvedConnectionConfig } from '../../src/shared/connection';
import { must } from './must';

const OPEN: ZookeeperAcl[] = [{ perms: 31, scheme: 'world', id: 'anyone' }];

export interface MemoryNode {
  data: Uint8Array;
  version: number;
  aversion?: number;
  ephemeralOwner: string;
  acl: ZookeeperAcl[];
}

/** The tree the fake sessions share: path → node. */
export class MemoryTree {
  readonly nodes = new Map<string, MemoryNode>([
    ['/', { data: new Uint8Array(), version: 0, ephemeralOwner: '0', acl: OPEN }],
  ]);
  private sequence = 0;

  put(path: string, data = '', owner = '0'): void {
    let at = '';
    for (const part of path.split('/').slice(1)) {
      at += `/${part}`;
      if (!this.nodes.has(at)) {
        this.nodes.set(at, { data: new Uint8Array(), version: 0, ephemeralOwner: '0', acl: OPEN });
      }
    }
    const node = this.nodes.get(path);
    if (node !== undefined) {
      node.data = new TextEncoder().encode(data);
      node.ephemeralOwner = owner;
    }
  }

  children(path: string): string[] {
    const prefix = path === '/' ? '/' : `${path}/`;
    return [...this.nodes.keys()]
      .filter((other) => other !== path && other.startsWith(prefix))
      .map((other) => other.slice(prefix.length))
      .filter((rest) => !rest.includes('/'));
  }

  stat(path: string): ZookeeperStat {
    const node = must(this.nodes.get(path));
    return {
      czxid: '1',
      mzxid: '2',
      pzxid: '3',
      ctime: 1_700_000_000_000,
      mtime: 1_700_000_100_000,
      version: node.version,
      cversion: 0,
      aversion: node.aversion ?? 0,
      ephemeralOwner: node.ephemeralOwner,
      dataLength: node.data.length,
      numChildren: this.children(path).length,
    };
  }

  next(): number {
    this.sequence += 1;
    return this.sequence - 1;
  }
}

const missing = (path: string): DbError =>
  new DbError('not-found', `no znode ${path}`, { driverCode: -101 });

export class FakeZookeeperSession implements ZookeeperSession {
  closed = false;
  readonly server: ZookeeperServerInfo = {
    sessionId: '1',
    sessionTimeoutMs: 15_000,
    readOnly: false,
    address: 'h:2181',
  };

  constructor(readonly tree: MemoryTree) {}

  private alive(): void {
    if (this.closed) {
      throw new DbError('connection-failed', 'The session is closed');
    }
  }

  children(path: string): Promise<{ names: string[]; stat: ZookeeperStat }> {
    this.alive();
    if (!this.tree.nodes.has(path)) {
      return Promise.reject(missing(path));
    }
    return Promise.resolve({ names: this.tree.children(path), stat: this.tree.stat(path) });
  }

  getData(path: string): Promise<{ data: Uint8Array; stat: ZookeeperStat }> {
    this.alive();
    const node = this.tree.nodes.get(path);
    return node === undefined
      ? Promise.reject(missing(path))
      : Promise.resolve({ data: node.data, stat: this.tree.stat(path) });
  }

  exists(path: string): Promise<ZookeeperStat | undefined> {
    this.alive();
    return Promise.resolve(this.tree.nodes.has(path) ? this.tree.stat(path) : undefined);
  }

  getAcl(path: string): Promise<{ acl: ZookeeperAcl[]; stat: ZookeeperStat }> {
    this.alive();
    const node = this.tree.nodes.get(path);
    return node === undefined
      ? Promise.reject(missing(path))
      : Promise.resolve({ acl: node.acl, stat: this.tree.stat(path) });
  }

  /** The version `serverVersion` answers; undefined: the server does not say. */
  version: string | undefined = '3.9.3';

  setAcl(path: string, acl: readonly ZookeeperAcl[], version: number): Promise<ZookeeperStat> {
    this.alive();
    const node = this.tree.nodes.get(path);
    if (node === undefined) {
      return Promise.reject(missing(path));
    }
    if (version !== -1 && version !== (node.aversion ?? 0)) {
      return Promise.reject(new DbError('constraint', 'bad version', { driverCode: -103 }));
    }
    if (acl.length === 0) {
      return Promise.reject(new DbError('permission-denied', 'invalid ACL', { driverCode: -114 }));
    }
    node.acl = [...acl];
    node.aversion = (node.aversion ?? 0) + 1;
    return Promise.resolve(this.tree.stat(path));
  }

  serverVersion(): Promise<string | undefined> {
    return Promise.resolve(this.version);
  }

  create(path: string, data: Uint8Array, mode: ZookeeperCreateMode): Promise<string> {
    this.alive();
    const parent = path.slice(0, path.lastIndexOf('/')) || '/';
    if (!this.tree.nodes.has(parent)) {
      return Promise.reject(missing(parent));
    }
    const made =
      mode === 'sequential' ? `${path}${String(this.tree.next()).padStart(10, '0')}` : path;
    if (this.tree.nodes.has(made)) {
      return Promise.reject(new DbError('constraint', `${made} exists`, { driverCode: -110 }));
    }
    this.tree.nodes.set(made, { data, version: 0, ephemeralOwner: '0', acl: OPEN });
    return Promise.resolve(made);
  }

  setData(path: string, data: Uint8Array, version: number): Promise<ZookeeperStat> {
    this.alive();
    const node = this.tree.nodes.get(path);
    if (node === undefined) {
      return Promise.reject(missing(path));
    }
    if (version !== -1 && version !== node.version) {
      return Promise.reject(new DbError('constraint', 'bad version', { driverCode: -103 }));
    }
    node.data = data;
    node.version += 1;
    return Promise.resolve(this.tree.stat(path));
  }

  remove(path: string, version: number): Promise<void> {
    this.alive();
    const node = this.tree.nodes.get(path);
    if (node === undefined) {
      return Promise.reject(missing(path));
    }
    if (version !== -1 && version !== node.version) {
      return Promise.reject(new DbError('constraint', 'bad version', { driverCode: -103 }));
    }
    if (this.tree.children(path).length > 0) {
      return Promise.reject(new DbError('constraint', 'not empty', { driverCode: -111 }));
    }
    this.tree.nodes.delete(path);
    return Promise.resolve();
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class FakeZookeeperDriver implements ZookeeperDriver {
  readonly id = 'zookeeper' as const;
  readonly configs: ResolvedConnectionConfig[] = [];
  readonly sessions: FakeZookeeperSession[] = [];
  failure: Error | undefined;

  constructor(readonly tree: MemoryTree = new MemoryTree()) {}

  openSession(config: ResolvedConnectionConfig): Promise<ZookeeperSession> {
    this.configs.push(config);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const session = new FakeZookeeperSession(this.tree);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}
