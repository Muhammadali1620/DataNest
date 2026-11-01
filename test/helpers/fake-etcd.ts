// A small etcd in memory, speaking the JSON gateway's shapes (V13.19): keys as base64,
// 64-bit numbers as strings, zero values left out of the answers. It keeps revisions,
// versions and leases, answers the compare-and-swap transactions the way etcd does, and
// counts the calls, so tests can say how much a read cost. `call` is what the services
// use; `handle` is the same logic with an HTTP status, for a real server in front of it.

import { DbError } from '../../src/core/errors';
import { etcdFailure } from '../../src/drivers/etcd/errors';
import type {
  EtcdCallOptions,
  EtcdDriver,
  EtcdServerInfo,
  EtcdSession,
} from '../../src/drivers/etcd-driver';
import type { ResolvedConnectionConfig } from '../../src/shared/connection';

interface Stored {
  value: Uint8Array;
  create: number;
  mod: number;
  version: number;
  lease: number;
}

interface Lease {
  ttl: number;
  grantedTtl: number;
}

export interface GatewayAnswer {
  readonly status: number;
  readonly body: unknown;
}

const b64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString('base64');
const unb64 = (text: unknown): Uint8Array =>
  typeof text === 'string' ? new Uint8Array(Buffer.from(text, 'base64')) : new Uint8Array();

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return a.length - b.length;
}

const fail = (code: number, message: string, status = 400): GatewayAnswer => ({
  status,
  body: { error: message, code, message },
});

export class FakeEtcd {
  /** Every call, by path: how many reads a listing cost. */
  readonly calls: string[] = [];
  /** The request bodies, in order. */
  readonly bodies: Record<string, unknown>[] = [];
  readonly version = '3.5.17';
  revision = 1;
  /** Fails the next call with this answer, once. */
  failNext: GatewayAnswer | undefined;
  /** The keys the gateway sees as sorted bytes. */
  private readonly store = new Map<string, Stored>();
  private readonly leases = new Map<number, Lease>();
  private nextLease = 7_000_000_000_000_000_001n;
  private readonly bigLeases = new Map<string, number>();

  // --- authentication, when a test asks for it ---
  /** Users and passwords; when set, every call but a few needs a token. */
  users: Map<string, string> | undefined;
  /** Tokens handed out, by value → user. */
  readonly tokens = new Map<string, string>();
  private tokenCount = 0;
  /** Makes the cluster forget its tokens, as a restart or an expiry does. */
  forgetTokens(): void {
    this.tokens.clear();
  }

  get size(): number {
    return this.store.size;
  }

  keyNames(): string[] {
    return this.sorted().map(([key]) => Buffer.from(key, 'base64').toString('utf8'));
  }

  /** Puts a key directly, as another client would. */
  seed(key: string, value = '', lease = 0): void {
    this.put(new TextEncoder().encode(key), new TextEncoder().encode(value), lease);
  }

  valueOf(key: string): string | undefined {
    const stored = this.store.get(b64(new TextEncoder().encode(key)));
    return stored === undefined ? undefined : new TextDecoder().decode(stored.value);
  }

  /** The id of the lease a key is on: "0" for none, undefined for no such key. */
  leaseOf(key: string): string | undefined {
    const stored = this.store.get(b64(new TextEncoder().encode(key)));
    return stored === undefined
      ? undefined
      : stored.lease === 0
        ? '0'
        : this.leaseText(stored.lease);
  }

  get leaseIds(): string[] {
    return [...this.bigLeases.keys()];
  }

  /** The service-facing call: a refused answer rejects like the driver's session does. */
  call = (
    path: string,
    body: Readonly<Record<string, unknown>>,
    _options?: EtcdCallOptions,
  ): Promise<unknown> => {
    const answer = this.handle(path, body, undefined);
    return answer.status >= 400
      ? Promise.reject(etcdFailure(answer.status, JSON.stringify(answer.body)))
      : Promise.resolve(answer.body);
  };

  server(): EtcdServerInfo {
    return { version: this.version, clusterId: '1', dbSizeBytes: 0, authenticated: false };
  }

  handle(path: string, body: Record<string, unknown>, token: string | undefined): GatewayAnswer {
    this.calls.push(path);
    this.bodies.push(body);
    if (this.failNext !== undefined) {
      const answer = this.failNext;
      this.failNext = undefined;
      return answer;
    }
    if (path === 'auth/authenticate') {
      return this.authenticate(body);
    }
    if (this.users !== undefined && path !== 'maintenance/status' && path !== 'auth/status') {
      const refused = this.checkToken(token);
      if (refused !== undefined) {
        return refused;
      }
    }
    switch (path) {
      case 'maintenance/status':
        return {
          status: 200,
          body: { header: this.header(), version: this.version, dbSize: '20480' },
        };
      case 'auth/status':
        return this.users === undefined
          ? { status: 200, body: { header: this.header(), authRevision: '1' } }
          : fail(3, 'etcdserver: user name is empty');
      case 'kv/range':
        return this.range(body);
      case 'kv/put':
        return this.putRequest(body);
      case 'kv/deleterange':
        return { status: 200, body: { header: this.header(), ...this.deleteRange(body) } };
      case 'kv/txn':
        return this.txn(body);
      case 'lease/grant':
        return this.grant(body);
      case 'lease/revoke':
        return this.revoke(body);
      case 'lease/timetolive':
        return this.timeToLive(body);
      default:
        return { status: 404, body: { code: 12, message: 'Not Found' } };
    }
  }

  /** Lets a lease run out, as time would. */
  expire(id: string): void {
    this.revokeLease(id);
  }

  setLeaseTtl(id: string, ttl: number): void {
    const key = this.bigLeases.get(id);
    const lease = key === undefined ? undefined : this.leases.get(key);
    if (lease !== undefined) {
      lease.ttl = ttl;
    }
  }

  private header(): Record<string, string> {
    return { cluster_id: '1', member_id: '2', revision: String(this.revision), raft_term: '3' };
  }

  private authenticate(body: Record<string, unknown>): GatewayAnswer {
    if (this.users === undefined) {
      return fail(9, 'etcdserver: authentication is not enabled');
    }
    const name = typeof body.name === 'string' ? body.name : '';
    if (this.users.get(name) === undefined || this.users.get(name) !== body.password) {
      return fail(3, 'etcdserver: authentication failed, invalid user ID or password');
    }
    this.tokenCount += 1;
    const token = `token-${this.tokenCount}`;
    this.tokens.set(token, name);
    return { status: 200, body: { header: this.header(), token } };
  }

  private checkToken(token: string | undefined): GatewayAnswer | undefined {
    if (token === undefined) {
      return fail(3, 'etcdserver: user name is empty');
    }
    return this.tokens.has(token) ? undefined : fail(16, 'etcdserver: invalid auth token', 401);
  }

  private sorted(): [string, Stored][] {
    return [...this.store.entries()].sort((a, b) => compareBytes(unb64(a[0]), unb64(b[0])));
  }

  private wire(key: string, stored: Stored, keysOnly: boolean): Record<string, unknown> {
    return {
      key,
      create_revision: String(stored.create),
      mod_revision: String(stored.mod),
      ...(stored.version > 0 ? { version: String(stored.version) } : {}),
      ...(!keysOnly && stored.value.length > 0 ? { value: b64(stored.value) } : {}),
      ...(stored.lease === 0 ? {} : { lease: this.leaseText(stored.lease) }),
    };
  }

  private leaseText(index: number): string {
    for (const [text, at] of this.bigLeases) {
      if (at === index) {
        return text;
      }
    }
    return String(index);
  }

  /** The keys of `key` .. `range_end` the way etcd reads the pair. */
  private select(body: Record<string, unknown>): [string, Stored][] {
    const key = unb64(body.key);
    const end = body.range_end === undefined ? undefined : unb64(body.range_end);
    const all = this.sorted();
    if (end === undefined) {
      return all.filter(([name]) => compareBytes(unb64(name), key) === 0);
    }
    const toTheEnd = end.length === 1 && end[0] === 0;
    return all.filter(([name]) => {
      const bytes = unb64(name);
      return compareBytes(bytes, key) >= 0 && (toTheEnd || compareBytes(bytes, end) < 0);
    });
  }

  private range(body: Record<string, unknown>): GatewayAnswer {
    if (unb64(body.key).length === 0) {
      return fail(3, 'etcdserver: key is not provided');
    }
    const selected = this.select(body);
    const limit = Number(body.limit ?? 0);
    const page = limit > 0 ? selected.slice(0, limit) : selected;
    return {
      status: 200,
      body: {
        header: this.header(),
        ...(body.count_only === true
          ? {}
          : { kvs: page.map(([key, stored]) => this.wire(key, stored, body.keys_only === true)) }),
        ...(limit > 0 && selected.length > limit ? { more: true } : {}),
        ...(selected.length > 0 ? { count: String(selected.length) } : {}),
      },
    };
  }

  private put(key: Uint8Array, value: Uint8Array, lease: number): void {
    this.revision += 1;
    const name = b64(key);
    const old = this.store.get(name);
    if (old !== undefined && old.lease !== 0 && old.lease !== lease) {
      // A lease that lost its key keeps living; nothing to tidy.
    }
    this.store.set(name, {
      value,
      create: old?.create ?? this.revision,
      mod: this.revision,
      version: (old?.version ?? 0) + 1,
      lease,
    });
  }

  private putRequest(body: Record<string, unknown>): GatewayAnswer {
    const refused = this.applyPut(body);
    return refused ?? { status: 200, body: { header: this.header() } };
  }

  private applyPut(body: Record<string, unknown>): GatewayAnswer | undefined {
    const key = unb64(body.key);
    if (key.length === 0) {
      return fail(3, 'etcdserver: key is not provided');
    }
    const old = this.store.get(b64(key));
    let lease = 0;
    if (body.ignore_lease === true) {
      if (old === undefined) {
        return fail(3, 'etcdserver: key not found');
      }
      lease = old.lease;
    } else if (body.lease !== undefined && body.lease !== '0') {
      const id = typeof body.lease === 'string' ? body.lease : '';
      const index = this.bigLeases.get(id);
      if (index === undefined || !this.leases.has(index)) {
        return fail(5, 'etcdserver: requested lease not found', 404);
      }
      lease = index;
    }
    let value = unb64(body.value);
    if (body.ignore_value === true) {
      if (old === undefined) {
        return fail(3, 'etcdserver: key not found');
      }
      value = old.value;
    }
    this.put(key, value, lease);
    return undefined;
  }

  private deleteRange(body: Record<string, unknown>): { deleted?: string } {
    const doomed = this.select(body);
    if (doomed.length === 0) {
      return {};
    }
    this.revision += 1;
    for (const [name] of doomed) {
      this.store.delete(name);
    }
    return { deleted: String(doomed.length) };
  }

  private txn(body: Record<string, unknown>): GatewayAnswer {
    const compare = (body.compare ?? []) as Record<string, unknown>[];
    const success = (body.success ?? []) as Record<string, unknown>[];
    const failure = (body.failure ?? []) as Record<string, unknown>[];
    if (success.length > 128 || failure.length > 128) {
      return fail(3, 'etcdserver: too many operations in txn request');
    }
    const holds = compare.every((one) => {
      const stored = this.store.get(String(one.key));
      const target = one.target;
      const actual =
        target === 'MOD'
          ? (stored?.mod ?? 0)
          : target === 'VERSION'
            ? (stored?.version ?? 0)
            : target === 'CREATE'
              ? (stored?.create ?? 0)
              : 0;
      const wanted = Number(
        target === 'MOD'
          ? one.mod_revision
          : target === 'VERSION'
            ? one.version
            : one.create_revision,
      );
      return one.result === 'EQUAL' ? actual === wanted : false;
    });
    const responses: Record<string, unknown>[] = [];
    for (const operation of holds ? success : failure) {
      if (operation.request_put !== undefined) {
        const refused = this.applyPut(operation.request_put as Record<string, unknown>);
        if (refused !== undefined) {
          return refused;
        }
        responses.push({ response_put: { header: this.header() } });
      } else if (operation.request_delete_range !== undefined) {
        responses.push({
          response_delete_range: this.deleteRange(
            operation.request_delete_range as Record<string, unknown>,
          ),
        });
      } else if (operation.request_range !== undefined) {
        const answer = this.range(operation.request_range as Record<string, unknown>);
        responses.push({ response_range: answer.body });
      }
    }
    return {
      status: 200,
      body: { header: this.header(), ...(holds ? { succeeded: true } : {}), responses },
    };
  }

  private grant(body: Record<string, unknown>): GatewayAnswer {
    const ttl = Number(body.TTL);
    if (!Number.isFinite(ttl) || ttl < 1) {
      return fail(3, 'etcdserver: lease TTL is too small');
    }
    const id = String(this.nextLease);
    this.nextLease += 1n;
    const index = this.bigLeases.size + 1;
    this.bigLeases.set(id, index);
    this.leases.set(index, { ttl, grantedTtl: ttl });
    return { status: 200, body: { header: this.header(), ID: id, TTL: String(ttl) } };
  }

  private revokeLease(id: string): boolean {
    const index = this.bigLeases.get(id);
    if (index === undefined || !this.leases.has(index)) {
      return false;
    }
    this.leases.delete(index);
    const doomed = [...this.store.entries()].filter(([, stored]) => stored.lease === index);
    if (doomed.length > 0) {
      this.revision += 1;
      for (const [name] of doomed) {
        this.store.delete(name);
      }
    }
    return true;
  }

  private revoke(body: Record<string, unknown>): GatewayAnswer {
    return this.revokeLease(String(body.ID))
      ? { status: 200, body: { header: this.header() } }
      : fail(5, 'etcdserver: requested lease not found', 404);
  }

  private timeToLive(body: Record<string, unknown>): GatewayAnswer {
    const id = String(body.ID);
    const index = this.bigLeases.get(id);
    const lease = index === undefined ? undefined : this.leases.get(index);
    return {
      status: 200,
      body: {
        header: this.header(),
        ID: id,
        TTL: String(lease === undefined ? -1 : lease.ttl),
        ...(lease === undefined ? {} : { grantedTTL: String(lease.grantedTtl) }),
      },
    };
  }
}

/** A session over an in-memory cluster, for the connection manager's tests. */
export class FakeEtcdSession implements EtcdSession {
  closed = false;
  readonly server = new FakeEtcd().server();

  constructor(readonly cluster: FakeEtcd = new FakeEtcd()) {}

  call(
    path: string,
    body: Readonly<Record<string, unknown>>,
    options?: EtcdCallOptions,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new DbError('connection-failed', 'The session is closed'));
    }
    return this.cluster.call(path, body, options);
  }

  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

export class FakeEtcdDriver implements EtcdDriver {
  readonly id = 'etcd' as const;
  readonly configs: ResolvedConnectionConfig[] = [];
  readonly sessions: FakeEtcdSession[] = [];
  failure: Error | undefined;

  constructor(private readonly cluster: FakeEtcd = new FakeEtcd()) {}

  openSession(config: ResolvedConnectionConfig): Promise<EtcdSession> {
    this.configs.push(config);
    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }
    const session = new FakeEtcdSession(this.cluster);
    this.sessions.push(session);
    return Promise.resolve(session);
  }
}
