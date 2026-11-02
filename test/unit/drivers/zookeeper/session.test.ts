// The ZooKeeper client against a server in this process that speaks the same protocol:
// what it sends, how it reads the answers and the refusals, how it signs in, how a lost
// link or a silent server ends, and how TLS checks the certificate in each mode. The real
// server is the reference for the protocol itself (the `zookeeper` integration group).

import { readFileSync } from 'node:fs';
import * as net from 'node:net';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  chrootOf,
  openZookeeperSession,
  openZookeeperSessionWith,
  serversOf,
  zookeeperTarget,
} from '../../../../src/drivers/zookeeper/session';
import type { ZookeeperSession } from '../../../../src/drivers/zookeeper-driver';
import {
  DEFAULT_CONNECT_TIMEOUT_SECONDS,
  type ResolvedConnectionConfig,
} from '../../../../src/shared/connection';
import { digestId, FakeZookeeper } from '../../../helpers/fake-zookeeper';
import { ROOT } from '../../../helpers/repo';

const TLS = join(ROOT, 'docker', 'tls');
const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0)) {
    await step();
  }
});

async function serve(
  options: ConstructorParameters<typeof FakeZookeeper>[0] = {},
): Promise<{ server: FakeZookeeper; port: number }> {
  const server = new FakeZookeeper(options);
  const port = await server.start();
  cleanup.push(() => server.stop());
  return { server, port };
}

function config(
  port: number,
  overrides: Partial<ResolvedConnectionConfig> = {},
): ResolvedConnectionConfig {
  return {
    id: 'z',
    name: 'z',
    driver: 'zookeeper',
    host: '127.0.0.1',
    port,
    ...overrides,
  };
}

async function open(
  port: number,
  overrides: Partial<ResolvedConnectionConfig> = {},
): Promise<ZookeeperSession> {
  const session = await openZookeeperSession(config(port, overrides));
  cleanup.push(() => session.close());
  return session;
}

async function failure(promise: Promise<unknown>): Promise<DbError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof DbError) {
      return error;
    }
    throw error;
  }
  throw new Error('The call did not fail');
}

describe('serversOf', () => {
  it('splits a list and gives a server without a port the port box', () => {
    expect(serversOf('a:2181,b', 3000)).toEqual([
      { host: 'a', port: 2181 },
      { host: 'b', port: 3000 },
    ]);
    expect(serversOf(' a , , a ', undefined)).toEqual([{ host: 'a', port: 2181 }]);
  });

  it('takes IPv6 addresses in brackets', () => {
    expect(serversOf('[::1]:2182,[fe80::1]', 2181)).toEqual([
      { host: '::1', port: 2182 },
      { host: 'fe80::1', port: 2181 },
    ]);
  });

  it('falls back to localhost', () => {
    expect(serversOf(undefined, undefined)).toEqual([{ host: 'localhost', port: 2181 }]);
    expect(serversOf(' ,', 5)).toEqual([{ host: 'localhost', port: 5 }]);
  });
});

describe('chrootOf', () => {
  it('makes one absolute path without a trailing slash, or none', () => {
    expect(chrootOf(undefined)).toBe('');
    expect(chrootOf('  ')).toBe('');
    expect(chrootOf('/')).toBe('');
    expect(chrootOf('app')).toBe('/app');
    expect(chrootOf('/app/')).toBe('/app');
    expect(chrootOf('/a/b//')).toBe('/a/b');
  });
});

describe('zookeeperTarget', () => {
  it('uses the defaults of ZooKeeper', () => {
    const target = zookeeperTarget({ id: 't', name: 't', driver: 'zookeeper' }, undefined);
    expect(target).toMatchObject({
      servers: [{ host: 'localhost', port: 2181 }],
      chroot: '',
      user: '',
      password: '',
      connectTimeoutMs: DEFAULT_CONNECT_TIMEOUT_SECONDS * 1000,
    });
  });

  it('trims the user and keeps the password as typed', () => {
    const target = zookeeperTarget(
      {
        id: 't',
        name: 't',
        driver: 'zookeeper',
        host: 'a:1,b:2',
        user: ' bob ',
        password: ' pw ',
        database: '/x/',
        options: { connectTimeout: 5 },
      },
      undefined,
    );
    expect(target).toMatchObject({
      user: 'bob',
      password: ' pw ',
      chroot: '/x',
      connectTimeoutMs: 5000,
    });
    expect(target.servers).toHaveLength(2);
  });
});

describe('a session', () => {
  it('opens with what the server granted', async () => {
    const { port } = await serve({ sessionTimeoutMs: 9000 });
    const session = await open(port);
    expect(session.server.sessionTimeoutMs).toBe(9000);
    expect(session.server.sessionId).toBe((0x1000000).toString());
    expect(session.server.readOnly).toBe(false);
    expect(session.server.address).toBe(`127.0.0.1:${port}`);
  });

  it('says when the server took it in read-only mode', async () => {
    const { port } = await serve({ readOnly: true });
    expect((await open(port)).server.readOnly).toBe(true);
  });

  it('refuses a session the server does not grant', async () => {
    const { port } = await serve({ refuseSessions: true });
    const error = await failure(openZookeeperSession(config(port)));
    expect(error.code).toBe('connection-failed');
    expect(error.message).toMatch(/refused the session/u);
  });

  it('closes by telling the server', async () => {
    const { server, port } = await serve();
    const session = await openZookeeperSession(config(port));
    await session.close();
    await session.close();
    expect(server.closedSessions).toBe(1);
    expect((await failure(session.exists('/'))).code).toBe('connection-failed');
  });
});

describe('requests', () => {
  it('create, read, change and delete a znode', async () => {
    const { server, port } = await serve();
    const session = await open(port);
    expect(await session.create('/a', encode('one'), 'persistent')).toBe('/a');
    const first = await session.getData('/a');
    expect(decode(first.data)).toBe('one');
    expect(first.stat).toMatchObject({ version: 0, dataLength: 3, numChildren: 0 });
    expect((await session.setData('/a', encode('two!'), 0)).version).toBe(1);
    expect((await session.exists('/a'))?.dataLength).toBe(4);
    await session.remove('/a', 1);
    expect(await session.exists('/a')).toBeUndefined();
    expect(server.nodes.has('/a')).toBe(false);
  });

  it('refuse a change to a version that is gone, and a delete of a znode with children', async () => {
    const { port } = await serve();
    const session = await open(port);
    await session.create('/p', new Uint8Array(), 'persistent');
    await session.create('/p/c', new Uint8Array(), 'persistent');
    expect(await failure(session.setData('/p', encode('x'), 5))).toMatchObject({
      code: 'constraint',
      driverCode: -103,
    });
    expect(await failure(session.remove('/p', -1))).toMatchObject({
      code: 'constraint',
      driverCode: -111,
    });
    expect(await failure(session.create('/p', new Uint8Array(), 'persistent'))).toMatchObject({
      driverCode: -110,
    });
    expect((await failure(session.getData('/nothing'))).code).toBe('not-found');
    expect((await failure(session.create('/x/y', new Uint8Array(), 'persistent'))).code).toBe(
      'not-found',
    );
  });

  it('list the children with the stat of the znode', async () => {
    const { port } = await serve();
    const session = await open(port);
    for (const name of ['b', 'a']) {
      await session.create(`/${name}`, new Uint8Array(), 'persistent');
    }
    const listing = await session.children('/');
    expect([...listing.names].sort()).toEqual(['a', 'b']);
    expect(listing.stat.numChildren).toBe(2);
  });

  it('number a sequential znode and return its path', async () => {
    const { port } = await serve();
    const session = await open(port);
    expect(await session.create('/job-', new Uint8Array(), 'sequential')).toBe('/job-0000000000');
    expect(await session.create('/job-', new Uint8Array(), 'sequential')).toBe('/job-0000000001');
  });

  it('send the flags of a container', async () => {
    const { server, port } = await serve();
    const session = await open(port);
    await session.create('/box', new Uint8Array(), 'container');
    expect(server.statOf('/box').ephemeralOwner).toBe((1n << 63n).toString());
  });

  it('read the ACL of a znode', async () => {
    const { server, port } = await serve();
    server.seed('/guarded', 'x', {
      acl: [
        { perms: 1, scheme: 'digest', id: 'u:h' },
        { perms: 17, scheme: 'world', id: 'anyone' },
      ],
    });
    const session = await open(port);
    expect((await session.getAcl('/guarded')).acl).toEqual([
      { perms: 1, scheme: 'digest', id: 'u:h' },
      { perms: 17, scheme: 'world', id: 'anyone' },
    ]);
    expect((await session.getAcl('/')).acl[0]).toMatchObject({ scheme: 'world', perms: 31 });
  });

  it('keep text of other alphabets, bytes and empty data', async () => {
    const { port } = await serve();
    const session = await open(port);
    await session.create('/имя', encode('значение ✓'), 'persistent');
    expect(decode((await session.getData('/имя')).data)).toBe('значение ✓');
    await session.create('/bin', Uint8Array.from([0, 255, 10]), 'persistent');
    expect([...(await session.getData('/bin')).data]).toEqual([0, 255, 10]);
    await session.create('/empty', new Uint8Array(), 'persistent');
    expect((await session.getData('/empty')).data.length).toBe(0);
  });

  it('carry many requests at once and match the answers', async () => {
    const { port } = await serve();
    const session = await open(port);
    const names = Array.from({ length: 200 }, (_u, index) => `n${index}`);
    await Promise.all(names.map((name) => session.create(`/${name}`, encode(name), 'persistent')));
    const datas = await Promise.all(
      names.map(async (name) => decode((await session.getData(`/${name}`)).data)),
    );
    expect(datas).toEqual(names);
  });

  it('read an answer that comes in pieces', async () => {
    const { server, port } = await serve();
    server.seed('/big', 'x'.repeat(300_000));
    const session = await open(port);
    expect((await session.getData('/big')).data.length).toBe(300_000);
  });
});

describe('a chroot', () => {
  it('is the root of the paths, below and above', async () => {
    const { server, port } = await serve();
    server.seed('/app/inner', 'in');
    const session = await open(port, { database: '/app/' });
    expect(decode((await session.getData('/inner')).data)).toBe('in');
    expect(await session.create('/made', encode('m'), 'persistent')).toBe('/made');
    expect(server.nodes.has('/app/made')).toBe(true);
    expect([...(await session.children('/')).names].sort()).toEqual(['inner', 'made']);
    expect(await session.create('/s-', new Uint8Array(), 'sequential')).toBe('/s-0000000000');
    await session.remove('/made', -1);
    expect(server.nodes.has('/app/made')).toBe(false);
  });

  it('is refused when the server does not have it', async () => {
    const { port } = await serve();
    const error = await failure(openZookeeperSession(config(port, { database: '/missing' })));
    expect(error.code).toBe('not-found');
    expect(error.message).toContain('/missing');
  });
});

describe('signing in', () => {
  it('sends the digest credentials before the first request', async () => {
    const { server, port } = await serve();
    server.users.set('alice', 'secret');
    const session = await open(port, { user: 'alice', password: 'secret' });
    expect(server.logins).toEqual(['alice:secret']);
    await session.create('/mine', encode('x'), 'persistent');
    // The znode belongs to its creator: only the signed-in session may read it.
    expect(server.nodes.get('/mine')?.acl).toEqual([
      { perms: 31, scheme: 'digest', id: digestId('alice', 'secret') },
    ]);
    expect(decode((await session.getData('/mine')).data)).toBe('x');
    const stranger = await open(port);
    expect(await failure(stranger.getData('/mine'))).toMatchObject({
      code: 'permission-denied',
      driverCode: -102,
    });
  });

  it('makes open znodes when nobody signed in', async () => {
    const { server, port } = await serve();
    const session = await open(port);
    await session.create('/open', new Uint8Array(), 'persistent');
    expect(server.nodes.get('/open')?.acl).toEqual([{ perms: 31, scheme: 'world', id: 'anyone' }]);
    expect(server.logins).toEqual([]);
  });

  it('reports a refused sign-in', async () => {
    const { server, port } = await serve();
    server.users.set('alice', 'secret');
    const error = await failure(
      openZookeeperSession(config(port, { user: 'alice', password: 'no' })),
    );
    expect(error.code).toBe('auth-failed');
  });
});

describe('several servers', () => {
  it('tries the next one when the first does not answer', async () => {
    const { server, port } = await serve();
    const dead = net.createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) =>
      dead.close(() => {
        resolve();
      }),
    );
    const session = await open(port, { host: `127.0.0.1:${deadPort},127.0.0.1:${port}` });
    expect(session.server.address).toBe(`127.0.0.1:${port}`);
    expect(server.connects).toBe(1);
  });

  it('reports the last failure when none answers', async () => {
    const dead = net.createServer();
    await new Promise<void>((resolve) => dead.listen(0, '127.0.0.1', resolve));
    const deadPort = (dead.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) =>
      dead.close(() => {
        resolve();
      }),
    );
    const error = await failure(openZookeeperSession(config(deadPort)));
    expect(error.code).toBe('connection-failed');
  });
});

describe('a link that fails', () => {
  it('fails the requests in flight and every later one when the server goes', async () => {
    const { server, port } = await serve({ silent: true });
    const session = await open(port);
    const waiting = failure(session.getData('/'));
    await new Promise((resolve) => setTimeout(resolve, 50));
    server.dropAll();
    expect((await waiting).code).toBe('connection-failed');
    expect((await failure(session.exists('/'))).code).toBe('connection-failed');
  });

  it('gives up on a request the server does not answer', async () => {
    const { port } = await serve({ silent: true });
    const session = await openZookeeperSessionWith(config(port), 150);
    cleanup.push(() => session.close());
    const error = await failure(session.getData('/'));
    expect(error.code).toBe('timeout');
    expect(error.message).toContain('"/"');
  });

  it('gives up on a server that never answers the connect request', async () => {
    const { port } = await serve({ mute: true });
    const error = await failure(
      openZookeeperSession(config(port, { options: { connectTimeout: 1 } })),
    );
    expect(error.code).toBe('timeout');
  });

  it('refuses a server that is not ZooKeeper', async () => {
    const { server, port } = await serve();
    server.garbage = Buffer.from('HTTP/1.1 400 Bad Request\r\n\r\n');
    const error = await failure(openZookeeperSession(config(port)));
    expect(error.code).toBe('connection-failed');
  });

  it('drops a session that hears nothing for its timeout', async () => {
    const { server, port } = await serve({ sessionTimeoutMs: 1000 });
    const session = await open(port);
    server.answerPings = false;
    await new Promise((resolve) => setTimeout(resolve, 1800));
    const error = await failure(session.exists('/'));
    expect(error.code).toBe('connection-failed');
  }, 8000);

  it('keeps a quiet session alive with pings', async () => {
    const { port } = await serve({ sessionTimeoutMs: 1000 });
    const session = await open(port);
    await new Promise((resolve) => setTimeout(resolve, 1800));
    expect(await session.exists('/')).toBeDefined();
  }, 8000);
});

describe('TLS', () => {
  const material = (): { cert: Buffer; key: Buffer } => ({
    cert: readFileSync(join(TLS, 'server.crt')),
    key: readFileSync(join(TLS, 'server.key')),
  });

  it('trusts any certificate in require mode', async () => {
    const { port } = await serve({ tls: material() });
    const session = await open(port, { ssl: { mode: 'require' } });
    expect(await session.exists('/')).toBeDefined();
  });

  it('checks the issuer in verify-ca mode and the name in verify-full mode', async () => {
    const { port } = await serve({ tls: material() });
    const ca = join(TLS, 'ca.crt');
    await (await open(port, { ssl: { mode: 'verify-ca', ca } })).close();
    await (await open(port, { host: 'localhost', ssl: { mode: 'verify-full', ca } })).close();
    expect(
      (await failure(openZookeeperSession(config(port, { ssl: { mode: 'verify-ca' } })))).code,
    ).toBe('connection-failed');
    expect(
      (
        await failure(
          openZookeeperSession(
            config(port, { ssl: { mode: 'verify-ca', ca: join(TLS, 'other-ca.crt') } }),
          ),
        )
      ).code,
    ).toBe('connection-failed');
  });

  it('explains a TLS answer asked of a plain port', async () => {
    const { port } = await serve();
    const error = await failure(
      openZookeeperSession(
        config(port, { ssl: { mode: 'require' }, options: { connectTimeout: 1 } }),
      ),
    );
    // A plain server does not answer a TLS hello: the connect times out, or it hangs up.
    expect(['timeout', 'connection-failed']).toContain(error.code);
  });
});
