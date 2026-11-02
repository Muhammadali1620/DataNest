// What the ZooKeeper znode page (V13.24) shows and does, free of `vscode`: it reads the
// znode with its ACL and children, and runs the changes the page asks for, then reads
// again — the server is the source of truth, and other clients change znodes too. Every
// save checks the version the page read, so it never overwrites a change it has not seen.

import { createHash } from 'node:crypto';
import { DbError } from '../../core/errors';
import { msg } from '../../core/user-message';
import {
  deleteTree,
  readNode,
  type ZnodeDetails,
  type ZookeeperCaller,
} from '../../services/zookeeper/zk-ops';
import { MAX_STRING_BYTES } from '../../shared/protocols/redis-key';
import type { ZnodeAclEntry, ZookeeperNodeState } from '../../shared/protocols/zookeeper-node';
import { redisValueBytes, type RedisValue, redisValueOf } from '../../shared/redis-value';
import {
  joinPath,
  kindOfOwner,
  nameProblem,
  ZK_BAD_VERSION,
  ZK_NODE_EXISTS,
} from '../../shared/zk-path';
import type { ZookeeperCreateMode } from '../../drivers/zookeeper-driver';
import { aclProblem, isDigestHash } from '../../shared/zk-acl';

export interface ZookeeperNodeModelDeps {
  readonly path: string;
  readonly connectionName: string;
  readonly readOnly: boolean;
  /** The session of the znode's connection. */
  readonly session: () => Promise<ZookeeperCaller>;
}

function isCode(error: unknown, code: number): boolean {
  return error instanceof DbError && error.driverCode === code;
}

const EMPTY_STAT = {
  czxid: '0',
  mzxid: '0',
  pzxid: '0',
  ephemeralOwner: '0',
  ctime: 0,
  mtime: 0,
  version: 0,
  cversion: 0,
  aversion: 0,
  dataLength: 0,
  numChildren: 0,
} as const;

export class ZookeeperNodeModel {
  private details: ZnodeDetails | undefined;
  private conflict = false;
  private aclConflict = false;

  constructor(private readonly deps: ZookeeperNodeModelDeps) {}

  get currentPath(): string {
    return this.deps.path;
  }

  /** What the page renders. */
  state(): ZookeeperNodeState {
    const { details } = this;
    const stat = details?.stat ?? EMPTY_STAT;
    return {
      path: this.deps.path,
      connectionName: this.deps.connectionName,
      readOnly: this.deps.readOnly,
      exists: details !== undefined,
      ...(details?.data === undefined
        ? {}
        : { value: redisValueOf(details.data, MAX_STRING_BYTES, details.data.length) }),
      ...(details !== undefined && details.data === undefined ? { denied: true } : {}),
      size: stat.dataLength,
      kind: kindOfOwner(stat.ephemeralOwner),
      version: stat.version,
      cversion: stat.cversion,
      aversion: stat.aversion,
      czxid: stat.czxid,
      mzxid: stat.mzxid,
      pzxid: stat.pzxid,
      ephemeralOwner: stat.ephemeralOwner,
      ctime: stat.ctime,
      mtime: stat.mtime,
      numChildren: stat.numChildren,
      acl: details?.acl.map((entry) => ({ ...entry })) ?? [],
      children: [...(details?.children ?? [])],
      moreChildren: details?.moreChildren ?? false,
      ...(this.conflict ? { conflict: true } : {}),
      ...(this.aclConflict ? { aclConflict: true } : {}),
    };
  }

  /** Reads the znode again. */
  async refresh(): Promise<ZookeeperNodeState> {
    this.details = await readNode(await this.deps.session(), this.deps.path);
    this.conflict = false;
    this.aclConflict = false;
    return this.state();
  }

  /**
   * Saves the data. `version` is the version the page read. A znode that changed since is
   * refused (`saved: false`, the new content is read) unless `overwrite` is set, which
   * replaces whatever is there now. A znode that is not there is created.
   */
  async save(
    value: RedisValue,
    version: number,
    overwrite = false,
  ): Promise<{ readonly saved: boolean; readonly state: ZookeeperNodeState }> {
    this.requireWritable();
    const bytes = redisValueBytes(value);
    if (bytes === undefined) {
      throw new DbError(
        'syntax',
        msg('The value cannot be saved: it is cut short, or its hex digits do not come in pairs'),
      );
    }
    const session = await this.deps.session();
    const { path } = this.deps;
    const existing = this.details !== undefined;
    try {
      if (existing) {
        // "Replace it anyway" still checks: against the version that is there right now.
        const expected = overwrite ? ((await session.exists(path))?.version ?? -1) : version;
        await session.setData(path, bytes, expected);
      } else {
        await session.create(path, bytes, 'persistent');
      }
    } catch (error) {
      if (isCode(error, ZK_BAD_VERSION) || isCode(error, ZK_NODE_EXISTS)) {
        this.details = await readNode(session, path);
        this.conflict = true;
        return { saved: false, state: this.state() };
      }
      throw error;
    }
    return { saved: true, state: await this.refresh() };
  }

  /**
   * Replaces the ACL (V13.27). `aversion` is the version of the ACL the page read: an ACL
   * that changed since is refused (`saved: false`, the new ACL is read). A digest entry
   * typed `user:password` is stored as `user:hash`, the form the server keeps.
   */
  async saveAcl(
    acl: readonly ZnodeAclEntry[],
    aversion: number,
  ): Promise<{ readonly saved: boolean; readonly state: ZookeeperNodeState }> {
    this.requireWritable();
    if (acl.length === 0) {
      throw new DbError('syntax', msg('An ACL needs at least one entry'));
    }
    // A user without the admin permission is shown `user:x` for every digest entry: the
    // server hides the hash. Saving that back would set the password "x", so it is refused.
    const hidden = new Set(
      (this.details?.acl ?? [])
        .filter((entry) => entry.scheme === 'digest' && /^[^:]+:x$/u.test(entry.id))
        .map((entry) => entry.id),
    );
    for (const entry of acl) {
      if (entry.scheme === 'digest' && hidden.has(entry.id)) {
        throw new DbError(
          'syntax',
          msg(
            'The server hides the password hash of "{0}" from users without the admin permission: type user:password again to change it, or remove the entry',
            entry.id,
          ),
        );
      }
    }
    const entries = acl.map(hashedDigest);
    for (const entry of entries) {
      const problem = aclProblem(entry);
      if (problem !== undefined) {
        throw new DbError('syntax', aclProblemText(problem, entry));
      }
    }
    const session = await this.deps.session();
    try {
      await session.setAcl(this.deps.path, entries, aversion);
    } catch (error) {
      if (isCode(error, ZK_BAD_VERSION)) {
        this.details = await readNode(session, this.deps.path);
        this.conflict = false;
        this.aclConflict = true;
        return { saved: false, state: this.state() };
      }
      throw error;
    }
    return { saved: true, state: await this.refresh() };
  }

  /** Creates a child with empty data; returns its path (a sequential one has its number). */
  async createChild(name: string, mode: ZookeeperCreateMode): Promise<string> {
    this.requireWritable();
    const problem = nameProblem(name);
    if (problem !== undefined) {
      throw new DbError('syntax', nameProblemText(problem));
    }
    const session = await this.deps.session();
    const created = await session.create(joinPath(this.deps.path, name), new Uint8Array(), mode);
    await this.refresh();
    return created;
  }

  /** Deletes the znode and everything below it. */
  async deleteNode(): Promise<ZookeeperNodeState> {
    this.requireWritable();
    await deleteTree(await this.deps.session(), this.deps.path);
    return await this.refresh();
  }

  private requireWritable(): void {
    if (this.deps.readOnly) {
      throw new DbError(
        'permission-denied',
        msg('The connection is read-only: nothing may change'),
      );
    }
  }
}

/** A digest entry typed with a plain password gets the hash the server stores. */
function hashedDigest(entry: ZnodeAclEntry): ZnodeAclEntry {
  if (entry.scheme !== 'digest') {
    return entry;
  }
  const colon = entry.id.indexOf(':');
  if (colon <= 0 || colon === entry.id.length - 1) {
    return entry;
  }
  const user = entry.id.slice(0, colon);
  const password = entry.id.slice(colon + 1);
  if (isDigestHash(password)) {
    return entry;
  }
  const hash = createHash('sha1').update(`${user}:${password}`).digest('base64');
  return { ...entry, id: `${user}:${hash}` };
}

/** The words for an ACL entry the server would refuse. */
export function aclProblemText(
  problem: NonNullable<ReturnType<typeof aclProblem>>,
  entry: ZnodeAclEntry,
): string {
  switch (problem) {
    case 'scheme':
      return msg('"{0}" is not an ACL scheme the page can write', entry.scheme);
    case 'perms':
      return msg('Every ACL entry needs at least one permission');
    case 'world-id':
      return msg('The world scheme has one id: anyone');
    case 'auth-id':
      return msg('The auth scheme takes no id: it stands for whoever is signed in');
    case 'digest-id':
      return msg('A digest id is user:password (or user:hash)');
    case 'id-empty':
      return msg('The {0} scheme needs an id', entry.scheme);
  }
}

/** The words for a name that cannot be a znode's. */
export function nameProblemText(problem: ReturnType<typeof nameProblem>): string {
  switch (problem) {
    case 'empty':
      return msg('A znode needs a name');
    case 'slash':
      return msg('A name cannot contain "/": make a znode inside a znode instead');
    case 'dots':
      return msg('"." and ".." cannot be names of znodes');
    case 'null':
      return msg('A name cannot contain a null character');
    case 'long':
      return msg('A name can have up to 1000 characters');
    case undefined:
      return '';
  }
}
