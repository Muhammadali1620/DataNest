// What a ZooKeeper driver offers (V13.24): the few calls a znode browser needs, in plain
// values. Not a SQL driver (D81). ZooKeeper's 64-bit numbers (transaction ids, the owner of
// an ephemeral node) travel as decimal strings; data is bytes, because the server does not
// know what is in a znode. Paths are those of the connection's chroot: `/` is its root.

import type { ResolvedConnectionConfig } from '../shared/connection';

/** What the server said when the session opened. */
export interface ZookeeperServerInfo {
  /** The session id, a decimal number. */
  readonly sessionId: string;
  /** The timeout the server agreed to, in milliseconds. */
  readonly sessionTimeoutMs: number;
  /** The server accepted the session in read-only mode (it has lost its quorum). */
  readonly readOnly: boolean;
  /** The `host:port` the session is connected to. */
  readonly address: string;
}

/** The `Stat` of a znode. */
export interface ZookeeperStat {
  /** Transaction ids, decimal. */
  readonly czxid: string;
  readonly mzxid: string;
  readonly pzxid: string;
  /** Milliseconds since the epoch. */
  readonly ctime: number;
  readonly mtime: number;
  /** Changes to the data, to the children list and to the ACL. */
  readonly version: number;
  readonly cversion: number;
  readonly aversion: number;
  /** The session that owns an ephemeral node; `0` for any other node (decimal). */
  readonly ephemeralOwner: string;
  readonly dataLength: number;
  readonly numChildren: number;
}

export interface ZookeeperAcl {
  /** Bit set: read 1, write 2, create 4, delete 8, admin 16. */
  readonly perms: number;
  readonly scheme: string;
  readonly id: string;
}

/** How a new znode lives: for good, with a counter added to its name, or as a container. */
export type ZookeeperCreateMode = 'persistent' | 'sequential' | 'container';

export interface ZookeeperSession {
  readonly server: ZookeeperServerInfo;
  /** The names of the children, with the znode's own stat. */
  children(
    path: string,
  ): Promise<{ readonly names: readonly string[]; readonly stat: ZookeeperStat }>;
  getData(path: string): Promise<{ readonly data: Uint8Array; readonly stat: ZookeeperStat }>;
  /** The stat of a znode; undefined when there is none. */
  exists(path: string): Promise<ZookeeperStat | undefined>;
  getAcl(
    path: string,
  ): Promise<{ readonly acl: readonly ZookeeperAcl[]; readonly stat: ZookeeperStat }>;
  /** Creates a znode and returns its path (a sequential one gets its number). */
  create(path: string, data: Uint8Array, mode: ZookeeperCreateMode): Promise<string>;
  /** Writes the data if the znode is still at `version` (`-1`: whatever it is). */
  setData(path: string, data: Uint8Array, version: number): Promise<ZookeeperStat>;
  /** Deletes a znode without children, if it is still at `version` (`-1`: whatever it is). */
  remove(path: string, version: number): Promise<void>;
  close(): Promise<void>;
}

export interface ZookeeperDriver {
  readonly id: 'zookeeper';
  openSession(config: ResolvedConnectionConfig): Promise<ZookeeperSession>;
}

/** The shape of the lazily loaded bundle dist/drivers/zookeeper.js. */
export interface ZookeeperDriverModule {
  readonly driver: ZookeeperDriver;
}
