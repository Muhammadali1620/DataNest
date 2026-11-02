import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConnectionManager } from '../../../../src/services/connection-manager';
import {
  DEFAULT_CHILDREN_PER_LOAD,
  deniedEntry,
  entryOf,
  ZookeeperNodeBrowser,
} from '../../../../src/services/zookeeper/node-browser';
import { digestId } from '../../../helpers/fake-zookeeper';
import { RecordingLogger } from '../../../helpers/fakes';
import { type FakeEnsemble, fakeEnsemble } from '../../../helpers/zookeeper-session';

let ensemble: FakeEnsemble;
let acquired: string[];
let size = 4;

function browser(): ZookeeperNodeBrowser {
  const manager = {
    acquireZookeeper: (owner: string) => {
      acquired.push(owner);
      return Promise.resolve(ensemble.session);
    },
  } as unknown as Pick<ConnectionManager, 'acquireZookeeper'>;
  return new ZookeeperNodeBrowser({
    manager,
    settings: { childrenPerLoad: () => size },
    logger: new RecordingLogger(),
  });
}

beforeEach(async () => {
  ensemble = await fakeEnsemble();
  acquired = [];
  size = 4;
  for (let index = 0; index < 10; index += 1) {
    ensemble.server.seed(`/app/n${String(index).padStart(2, '0')}`);
  }
  ensemble.server.seed('/app/n01/child');
});

afterEach(async () => {
  await ensemble.close();
});

describe('entryOf', () => {
  it('reads the number of children, the kind and the size from a stat', () => {
    const stat = ensemble.server.statOf('/app/n01');
    expect(entryOf('/app', 'n01', stat)).toEqual({
      name: 'n01',
      path: '/app/n01',
      numChildren: 1,
      kind: 'persistent',
      dataLength: 0,
    });
    expect(entryOf('/', 'top', { ...stat, ephemeralOwner: '12345' })).toMatchObject({
      path: '/top',
      kind: 'ephemeral',
    });
  });

  it('marks a child the ACL hides', () => {
    expect(deniedEntry('/app', 'x')).toMatchObject({ path: '/app/x', denied: true });
  });
});

describe('ZookeeperNodeBrowser', () => {
  it('lists the first page, sorted, with a mark that more follows', async () => {
    const listing = await browser().children('c1', '/app');
    expect(listing.entries.map((entry) => entry.name)).toEqual(['n00', 'n01', 'n02', 'n03']);
    expect(listing).toMatchObject({ more: true, total: 10 });
    expect(listing.entries[1]).toMatchObject({ numChildren: 1, path: '/app/n01' });
    expect(acquired).toEqual(['tree:c1']);
  });

  it('brings the next pages one by one, to the end', async () => {
    const one = browser();
    await one.children('c1', '/app');
    await one.loadMore('c1', '/app');
    expect((await one.children('c1', '/app')).entries).toHaveLength(8);
    await one.loadMore('c1', '/app');
    const done = await one.children('c1', '/app');
    expect(done.entries).toHaveLength(10);
    expect(done.more).toBe(false);
    // Nothing more to bring: asking again changes nothing.
    await one.loadMore('c1', '/app');
    expect((await one.children('c1', '/app')).entries).toHaveLength(10);
    expect(ensemble.server.requests.filter((type) => type === 12)).toHaveLength(1);
  });

  it('does not load more of a znode that was never opened', async () => {
    await browser().loadMore('c1', '/app');
    expect(acquired).toEqual([]);
  });

  it('reads the first page once, however many ask at the same time', async () => {
    const one = browser();
    const [a, b] = await Promise.all([one.children('c1', '/app'), one.children('c1', '/app')]);
    expect(a.entries).toEqual(b.entries);
    expect(ensemble.server.requests.filter((type) => type === 12)).toHaveLength(1);
  });

  it('keeps the pages of each znode and each connection apart', async () => {
    const one = browser();
    await one.children('c1', '/app');
    expect((await one.children('c1', '/app/n01')).entries.map((entry) => entry.name)).toEqual([
      'child',
    ]);
    expect((await one.children('c2', '/app')).entries).toHaveLength(4);
    expect(acquired).toEqual(['tree:c1', 'tree:c1', 'tree:c2']);
  });

  it('forgets one connection or all of them', async () => {
    const one = browser();
    await one.children('c1', '/app');
    await one.children('c2', '/app');
    one.reset('c1');
    await one.children('c1', '/app');
    await one.children('c2', '/app');
    expect(acquired).toEqual(['tree:c1', 'tree:c2', 'tree:c1']);
    one.reset();
    await one.children('c2', '/app');
    expect(acquired).toHaveLength(4);
  });

  it('leaves out a child that went between the listing and its stat', async () => {
    const one = browser();
    size = 10;
    const real = ensemble.session.exists.bind(ensemble.session);
    const racing = {
      ...ensemble.session,
      children: ensemble.session.children.bind(ensemble.session),
      exists: async (path: string) => {
        if (path === '/app/n03') {
          return undefined;
        }
        return await real(path);
      },
    };
    const manager = {
      acquireZookeeper: () => Promise.resolve(racing),
    } as unknown as Pick<ConnectionManager, 'acquireZookeeper'>;
    const raced = new ZookeeperNodeBrowser({
      manager,
      settings: { childrenPerLoad: () => 10 },
      logger: new RecordingLogger(),
    });
    expect((await raced.children('c1', '/app')).entries).toHaveLength(9);
    expect(one).toBeDefined();
  });

  it('lists a child the ACL hides, marked, and goes on', async () => {
    ensemble.server.seed('/app/n02', '', {
      acl: [{ perms: 31, scheme: 'digest', id: digestId('alice', 'pw') }],
    });
    const listing = await browser().children('c1', '/app');
    expect(listing.entries[2]).toMatchObject({ name: 'n02', denied: true, numChildren: 0 });
    expect(listing.entries[3]).toMatchObject({ name: 'n03' });
    expect(listing.entries[3]?.denied).toBeUndefined();
  });

  it('forgets a failed read, so the next look tries again', async () => {
    const failing = {
      acquireZookeeper: () => Promise.reject(new Error('boom')),
    } as unknown as Pick<ConnectionManager, 'acquireZookeeper'>;
    const one = new ZookeeperNodeBrowser({ manager: failing, logger: new RecordingLogger() });
    await expect(one.children('c1', '/app')).rejects.toThrow('boom');
    await expect(one.children('c1', '/app')).rejects.toThrow('boom');
  });

  it('asks for 300 children at a time when no setting says otherwise', async () => {
    for (let index = 0; index < 320; index += 1) {
      ensemble.server.seed(`/lots/n${String(index).padStart(4, '0')}`);
    }
    const manager = {
      acquireZookeeper: () => Promise.resolve(ensemble.session),
    } as unknown as Pick<ConnectionManager, 'acquireZookeeper'>;
    const plain = new ZookeeperNodeBrowser({ manager, logger: new RecordingLogger() });
    const listing = await plain.children('c1', '/lots');
    expect(DEFAULT_CHILDREN_PER_LOAD).toBe(300);
    expect(listing.entries).toHaveLength(300);
    expect(listing).toMatchObject({ more: true, total: 320 });
  });
});
