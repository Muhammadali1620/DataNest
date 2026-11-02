import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { driver } from '../../../src/drivers/zookeeper';
import type { ZookeeperSession } from '../../../src/drivers/zookeeper-driver';
import type { ResolvedConnectionConfig } from '../../../src/shared/connection';
import { ZookeeperNodeModel } from '../../../src/vscode/panels/zookeeper-node-model';
import { deleteTree, countTree, readNode } from '../../../src/services/zookeeper/zk-ops';
import { ZookeeperNodeBrowser } from '../../../src/services/zookeeper/node-browser';
import { TEST_ZOOKEEPER } from '../../helpers/zookeeper-servers';
import type { ConnectionManager } from '../../../src/services/connection-manager';
import type { Logger } from '../../../src/core/logging/logger';

// docker/compose.yml `zookeeper` (V13.24): one standalone server, the client port open to
// everyone. Every test works below /dn-it and leaves nothing behind.
function config(overrides: Partial<ResolvedConnectionConfig> = {}): ResolvedConnectionConfig {
  return {
    id: 'test-zookeeper',
    name: 'ZooKeeper',
    driver: 'zookeeper',
    host: TEST_ZOOKEEPER.host,
    port: TEST_ZOOKEEPER.port,
    ...overrides,
  };
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const ROOT = '/dn-it';

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

const silentLogger = {
  child: () => silentLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
} as unknown as Logger;

describe('ZooKeeper driver on a ZooKeeper server', () => {
  let session: ZookeeperSession;

  /** Removes everything below /dn-it, also what the digest user made and nobody else may touch. */
  async function clean(): Promise<void> {
    if ((await session.exists(ROOT)) === undefined) {
      return;
    }
    const owner = await driver.openSession(config({ user: 'alice', password: 'secret' }));
    try {
      await deleteTree(owner, ROOT);
    } finally {
      await owner.close();
    }
  }

  beforeAll(async () => {
    session = await driver.openSession(config());
    await clean();
    await session.create(ROOT, new Uint8Array(), 'persistent');
  });

  afterAll(async () => {
    await clean();
    await session.close();
  });

  it('opens a session the server knows', () => {
    expect(session.server.sessionId).not.toBe('0');
    expect(session.server.sessionTimeoutMs).toBeGreaterThan(0);
    expect(session.server.readOnly).toBe(false);
    expect(session.server.address).toBe(`${TEST_ZOOKEEPER.host}:${TEST_ZOOKEEPER.port}`);
  });

  it('creates, reads, changes and deletes a znode, version by version', async () => {
    const path = `${ROOT}/plain`;
    expect(await session.create(path, encode('one'), 'persistent')).toBe(path);
    const first = await session.getData(path);
    expect(decode(first.data)).toBe('one');
    expect(first.stat).toMatchObject({
      version: 0,
      dataLength: 3,
      numChildren: 0,
      ephemeralOwner: '0',
    });
    expect(first.stat.ctime).toBeGreaterThan(1_600_000_000_000);
    const second = await session.setData(path, encode('three'), 0);
    expect(second.version).toBe(1);
    expect(second.dataLength).toBe(5);
    expect(BigInt(second.mzxid)).toBeGreaterThan(BigInt(first.stat.mzxid));
    // The version the writer saw is gone: nothing is overwritten.
    const stale = await failure(session.setData(path, encode('lost'), 0));
    expect(stale).toMatchObject({ code: 'constraint', driverCode: -103 });
    expect(decode((await session.getData(path)).data)).toBe('three');
    // -1 means whatever is there.
    expect((await session.setData(path, encode('any'), -1)).version).toBe(2);
    const wrongDelete = await failure(session.remove(path, 0));
    expect(wrongDelete.code).toBe('constraint');
    await session.remove(path, 2);
    expect(await session.exists(path)).toBeUndefined();
  });

  it('keeps bytes that are not text, empty data and names with other alphabets', async () => {
    const bytes = Uint8Array.from([0, 255, 128, 10, 13, 0, 1]);
    await session.create(`${ROOT}/binary`, bytes, 'persistent');
    expect([...(await session.getData(`${ROOT}/binary`)).data]).toEqual([...bytes]);
    await session.create(`${ROOT}/empty`, new Uint8Array(), 'persistent');
    expect((await session.getData(`${ROOT}/empty`)).data.length).toBe(0);
    await session.create(`${ROOT}/имя ключа ✓`, encode('значение'), 'persistent');
    expect(decode((await session.getData(`${ROOT}/имя ключа ✓`)).data)).toBe('значение');
    expect((await session.children(ROOT)).names).toContain('имя ключа ✓');
  });

  it('moves data of half a megabyte both ways', async () => {
    const big = encode('x'.repeat(500_000));
    await session.create(`${ROOT}/big`, big, 'persistent');
    const back = await session.getData(`${ROOT}/big`);
    expect(back.data.length).toBe(500_000);
    expect(back.stat.dataLength).toBe(500_000);
  });

  it('lists children with the stat of the znode itself', async () => {
    await session.create(`${ROOT}/list`, new Uint8Array(), 'persistent');
    for (const name of ['b', 'a', 'c']) {
      await session.create(`${ROOT}/list/${name}`, new Uint8Array(), 'persistent');
    }
    const listing = await session.children(`${ROOT}/list`);
    expect([...listing.names].sort()).toEqual(['a', 'b', 'c']);
    expect(listing.stat.numChildren).toBe(3);
    expect(listing.stat.cversion).toBe(3);
  });

  it('refuses what the server refuses, in the kinds the app knows', async () => {
    expect(await session.exists(`${ROOT}/nothing`)).toBeUndefined();
    expect((await failure(session.getData(`${ROOT}/nothing`))).code).toBe('not-found');
    expect((await failure(session.children(`${ROOT}/nothing`))).code).toBe('not-found');
    expect(
      (await failure(session.create(`${ROOT}/nothing/deeper`, new Uint8Array(), 'persistent')))
        .code,
    ).toBe('not-found');
    await session.create(`${ROOT}/twice`, new Uint8Array(), 'persistent');
    expect(
      (await failure(session.create(`${ROOT}/twice`, new Uint8Array(), 'persistent'))).driverCode,
    ).toBe(-110);
    await session.create(`${ROOT}/twice/child`, new Uint8Array(), 'persistent');
    expect((await failure(session.remove(`${ROOT}/twice`, -1))).driverCode).toBe(-111);
    expect((await failure(session.remove('/', -1))).code).toBe('syntax');
  });

  it('numbers a sequential znode and creates a container', async () => {
    await session.create(`${ROOT}/seq`, new Uint8Array(), 'persistent');
    const first = await session.create(`${ROOT}/seq/job-`, new Uint8Array(), 'sequential');
    const second = await session.create(`${ROOT}/seq/job-`, new Uint8Array(), 'sequential');
    expect(first).toMatch(/\/seq\/job-\d{10}$/u);
    expect(second > first).toBe(true);
    const container = await session.create(`${ROOT}/box`, new Uint8Array(), 'container');
    // The server hides the owner of a container from clients: it reads as an ordinary znode.
    const stat = await session.exists(container);
    expect(stat).toMatchObject({ ephemeralOwner: '0', numChildren: 0 });
  });

  it('shows the ACL of a znode', async () => {
    const acl = await session.getAcl(ROOT);
    expect(acl.acl).toEqual([{ perms: 31, scheme: 'world', id: 'anyone' }]);
    expect(acl.stat.aversion).toBe(0);
  });

  it('answers many requests at once in the right order', async () => {
    await session.create(`${ROOT}/many`, new Uint8Array(), 'persistent');
    const names = Array.from(
      { length: 600 },
      (_unused, index) => `n${String(index).padStart(4, '0')}`,
    );
    await Promise.all(
      names.map((name) => session.create(`${ROOT}/many/${name}`, encode(name), 'persistent')),
    );
    const listing = await session.children(`${ROOT}/many`);
    expect(listing.names).toHaveLength(600);
    const datas = await Promise.all(
      names.map(async (name) => decode((await session.getData(`${ROOT}/many/${name}`)).data)),
    );
    expect(datas).toEqual(names);
  });

  it('works below a chroot, and refuses one that is not there', async () => {
    await session.create(`${ROOT}/root`, encode('top'), 'persistent');
    const inner = await driver.openSession(config({ database: `${ROOT}/root/` }));
    try {
      expect(decode((await inner.getData('/')).data)).toBe('top');
      expect(await inner.create('/child', encode('c'), 'persistent')).toBe('/child');
      expect((await inner.children('/')).names).toEqual(['child']);
    } finally {
      await inner.close();
    }
    expect(decode((await session.getData(`${ROOT}/root/child`)).data)).toBe('c');
    const missing = await failure(driver.openSession(config({ database: `${ROOT}/no-such-root` })));
    expect(missing.code).toBe('not-found');
  });

  it('signs in with the digest scheme, and the znodes it makes belong to its user', async () => {
    const owner = await driver.openSession(config({ user: 'alice', password: 'secret' }));
    try {
      await owner.create(`${ROOT}/private`, encode('mine'), 'persistent');
      const acl = await owner.getAcl(`${ROOT}/private`);
      expect(acl.acl).toHaveLength(1);
      expect(acl.acl[0]).toMatchObject({ perms: 31, scheme: 'digest' });
      expect(acl.acl[0]?.id.startsWith('alice:')).toBe(true);
      expect(decode((await owner.getData(`${ROOT}/private`)).data)).toBe('mine');
      // Somebody who did not sign in cannot read it.
      const denied = await failure(session.getData(`${ROOT}/private`));
      expect(denied).toMatchObject({ code: 'permission-denied', driverCode: -102 });
      // The stat wants the same permission as the data: nothing can be shown but the znode.
      expect((await failure(session.exists(`${ROOT}/private`))).code).toBe('permission-denied');
      const details = await readNode(session, `${ROOT}/private`);
      expect(details?.data).toBeUndefined();
      expect(details?.children).toEqual([]);
      expect(details?.acl).toEqual([]);
      // A listing of the parent still names it, marked as unreadable.
      const manager = { acquireZookeeper: () => Promise.resolve(session) } as unknown as Pick<
        ConnectionManager,
        'acquireZookeeper'
      >;
      const listing = await new ZookeeperNodeBrowser({ manager, logger: silentLogger }).children(
        'c',
        ROOT,
      );
      expect(listing.entries.find((entry) => entry.name === 'private')).toMatchObject({
        denied: true,
      });
    } finally {
      await owner.close();
    }
  });

  it('reports a server that is not there and one that is not ZooKeeper', async () => {
    const refused = await failure(
      driver.openSession(config({ port: 1, options: { connectTimeout: 2 } })),
    );
    expect(refused.code).toBe('connection-failed');
    // The HTTP port of the server's admin interface is not the client protocol.
    const wrong = await failure(
      driver.openSession(
        config({
          host: '127.0.0.1',
          port: TEST_ZOOKEEPER.port + 1,
          options: { connectTimeout: 2 },
        }),
      ),
    ).catch(() => undefined);
    expect(wrong === undefined || wrong instanceof DbError).toBe(true);
  });

  it('is read by the page model: refresh, save with a version, conflict, overwrite, delete', async () => {
    const path = `${ROOT}/model`;
    await session.create(path, encode('first'), 'persistent');
    const model = new ZookeeperNodeModel({
      path,
      connectionName: 'ZooKeeper',
      readOnly: false,
      session: () => Promise.resolve(session),
    });
    const loaded = await model.refresh();
    expect(loaded).toMatchObject({ exists: true, version: 0, kind: 'persistent', size: 5 });
    expect(loaded.acl[0]).toMatchObject({ scheme: 'world' });
    expect((await model.save({ text: 'second' }, loaded.version)).saved).toBe(true);
    // Somebody else changes it meanwhile.
    await session.setData(path, encode('theirs'), -1);
    const refused = await model.save({ text: 'mine' }, 1);
    expect(refused.saved).toBe(false);
    expect(refused.state).toMatchObject({ conflict: true, version: 2 });
    expect(decode((await session.getData(path)).data)).toBe('theirs');
    const replaced = await model.save({ text: 'mine' }, 1, true);
    expect(replaced.saved).toBe(true);
    expect(decode((await session.getData(path)).data)).toBe('mine');
    await model.createChild('kid', 'persistent');
    expect((await model.refresh()).children).toEqual(['kid']);
    const gone = await model.deleteNode();
    expect(gone.exists).toBe(false);
    expect(await session.exists(`${path}/kid`)).toBeUndefined();
  });

  it('changes the ACL through the page model, hashing a digest and refusing a stale version (V13.27)', async () => {
    const path = `${ROOT}/acl`;
    await session.create(path, encode('x'), 'persistent');
    const model = new ZookeeperNodeModel({
      path,
      connectionName: 'ZooKeeper',
      readOnly: false,
      session: () => Promise.resolve(session),
    });
    const loaded = await model.refresh();
    // Everyone keeps the admin permission, so the page still sees what it stored.
    const acl = [
      { perms: 31, scheme: 'digest', id: 'alice:secret' },
      { perms: 31, scheme: 'world', id: 'anyone' },
    ];
    const saved = await model.saveAcl(acl, loaded.aversion);
    expect(saved.saved).toBe(true);
    expect(saved.state.aversion).toBe(1);
    expect(saved.state.acl[0]?.id).toMatch(/^alice:[A-Za-z0-9+/]{27}=$/u);
    expect(saved.state.acl[0]?.id).not.toContain('secret');
    // The ACL version the page read is gone: the change is refused and the new ACL shown.
    const stale = await model.saveAcl(acl, 0);
    expect(stale.saved).toBe(false);
    expect(stale.state.aclConflict).toBe(true);
    expect(stale.state.aversion).toBe(1);
  });

  it('is shown the digest id hidden when it lacks the admin permission, and will not write it back', async () => {
    const path = `${ROOT}/hidden`;
    await session.create(path, encode('x'), 'persistent');
    const owner = await driver.openSession(config({ user: 'alice', password: 'secret' }));
    try {
      await owner.setAcl(
        path,
        [
          { perms: 31, scheme: 'auth', id: '' },
          { perms: 1, scheme: 'world', id: 'anyone' },
        ],
        -1,
      );
      const model = new ZookeeperNodeModel({
        path,
        connectionName: 'ZooKeeper',
        readOnly: false,
        session: () => Promise.resolve(session),
      });
      const shown = await model.refresh();
      expect(shown.acl).toEqual([
        { perms: 31, scheme: 'digest', id: 'alice:x' },
        { perms: 1, scheme: 'world', id: 'anyone' },
      ]);
      await expect(model.saveAcl(shown.acl, shown.aversion)).rejects.toMatchObject({
        code: 'syntax',
      });
      // Without the admin permission the server refuses before it looks at the version.
      expect(
        await failure(session.setAcl(path, [{ perms: 1, scheme: 'world', id: 'anyone' }], -1)),
      ).toMatchObject({ code: 'permission-denied' });
    } finally {
      await owner.close();
    }
  });

  it('refuses an ACL the server finds invalid, as permission-denied', async () => {
    const path = `${ROOT}/badacl`;
    await session.create(path, new Uint8Array(), 'persistent');
    expect(
      await failure(session.setAcl(path, [{ perms: 31, scheme: 'kerberos', id: 'x' }], -1)),
    ).toMatchObject({ code: 'permission-denied' });
  });

  it('asks the server for its version with srvr, and for the session timeout it wants (V13.27)', async () => {
    expect(await session.serverVersion()).toMatch(/^3\.\d+\.\d+$/u);
    const quick = await driver.openSession(config({ options: { sessionTimeout: 10 } }));
    try {
      expect(quick.server.sessionTimeoutMs).toBe(10_000);
    } finally {
      await quick.close();
    }
  });

  it('counts and deletes a whole subtree', async () => {
    await session.create(`${ROOT}/tree`, new Uint8Array(), 'persistent');
    for (const a of ['x', 'y']) {
      await session.create(`${ROOT}/tree/${a}`, new Uint8Array(), 'persistent');
      for (const b of ['1', '2', '3']) {
        await session.create(`${ROOT}/tree/${a}/${b}`, new Uint8Array(), 'persistent');
      }
    }
    expect(await countTree(session, `${ROOT}/tree`)).toEqual({ count: 9, capped: false });
    expect(await countTree(session, `${ROOT}/tree`, 4)).toEqual({ count: 4, capped: true });
    expect(await deleteTree(session, `${ROOT}/tree`)).toBe(9);
    expect(await session.exists(`${ROOT}/tree`)).toBeUndefined();
  });

  it('pages the children of a znode for the tree', async () => {
    await session.create(`${ROOT}/paged`, new Uint8Array(), 'persistent');
    for (let index = 0; index < 25; index += 1) {
      await session.create(
        `${ROOT}/paged/c${String(index).padStart(2, '0')}`,
        new Uint8Array(),
        'persistent',
      );
    }
    await session.create(`${ROOT}/paged/c00/leaf`, new Uint8Array(), 'persistent');
    const manager = {
      acquireZookeeper: () => Promise.resolve(session),
    } as unknown as Pick<ConnectionManager, 'acquireZookeeper'>;
    const browser = new ZookeeperNodeBrowser({
      manager,
      settings: { childrenPerLoad: () => 10 },
      logger: silentLogger,
    });
    const first = await browser.children('c', `${ROOT}/paged`);
    expect(first.entries.map((entry) => entry.name)).toEqual(
      Array.from({ length: 10 }, (_u, i) => `c${String(i).padStart(2, '0')}`),
    );
    expect(first).toMatchObject({ more: true, total: 25 });
    expect(first.entries[0]).toMatchObject({ numChildren: 1, kind: 'persistent' });
    await browser.loadMore('c', `${ROOT}/paged`);
    await browser.loadMore('c', `${ROOT}/paged`);
    const all = await browser.children('c', `${ROOT}/paged`);
    expect(all.entries).toHaveLength(25);
    expect(all.more).toBe(false);
  });

  it('closes its session on the server', async () => {
    const other = await driver.openSession(config());
    await other.close();
    // A closed session answers nothing more.
    expect((await failure(other.exists('/'))).code).toBe('connection-failed');
  });
});
