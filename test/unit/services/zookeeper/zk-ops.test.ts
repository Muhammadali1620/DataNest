import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  compareNames,
  countTree,
  deleteTree,
  mapLimited,
  PAGE_CHILDREN,
  readNode,
  UNKNOWN_STAT,
} from '../../../../src/services/zookeeper/zk-ops';
import { digestId } from '../../../helpers/fake-zookeeper';
import { type FakeEnsemble, fakeEnsemble } from '../../../helpers/zookeeper-session';

let ensemble: FakeEnsemble;

beforeEach(async () => {
  ensemble = await fakeEnsemble();
});

afterEach(async () => {
  await ensemble.close();
});

describe('compareNames', () => {
  it('orders by code units, not by the locale', () => {
    expect(['b', 'B', 'a', 'é', 'Z'].sort(compareNames)).toEqual(['B', 'Z', 'a', 'b', 'é']);
    expect(compareNames('a', 'a')).toBe(0);
  });
});

describe('mapLimited', () => {
  it('returns the results in order and runs a limited number at once', async () => {
    let running = 0;
    let most = 0;
    const results = await mapLimited(
      Array.from({ length: 100 }, (_u, index) => index),
      async (item) => {
        running += 1;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 1));
        running -= 1;
        return item * 2;
      },
    );
    expect(results).toEqual(Array.from({ length: 100 }, (_u, index) => index * 2));
    expect(most).toBeLessThanOrEqual(32);
    expect(most).toBeGreaterThan(1);
  });

  it('copes with nothing to do', async () => {
    expect(await mapLimited([], () => Promise.resolve(1))).toEqual([]);
  });
});

describe('readNode', () => {
  it('reads the data, the ACL and the sorted children of a znode', async () => {
    ensemble.server.seed('/app', 'hello');
    for (const name of ['c', 'a', 'b']) {
      ensemble.server.seed(`/app/${name}`);
    }
    const details = await readNode(ensemble.session, '/app');
    expect(details).toBeDefined();
    expect(new TextDecoder().decode(details?.data)).toBe('hello');
    expect(details?.children).toEqual(['a', 'b', 'c']);
    expect(details?.moreChildren).toBe(false);
    expect(details?.acl).toEqual([{ perms: 31, scheme: 'world', id: 'anyone' }]);
    expect(details?.stat).toMatchObject({ dataLength: 5, numChildren: 3 });
  });

  it('cuts a long list of children and says so', async () => {
    for (let index = 0; index < PAGE_CHILDREN + 5; index += 1) {
      ensemble.server.seed(`/many/n${String(index).padStart(4, '0')}`);
    }
    const details = await readNode(ensemble.session, '/many');
    expect(details?.children).toHaveLength(PAGE_CHILDREN);
    expect(details?.children[0]).toBe('n0000');
    expect(details?.moreChildren).toBe(true);
  });

  it('is undefined for a znode that is not there', async () => {
    expect(await readNode(ensemble.session, '/nothing')).toBeUndefined();
  });

  it('knows nothing of a znode its ACL hides, but that it is there', async () => {
    ensemble.server.seed('/secret', 'x', {
      acl: [{ perms: 31, scheme: 'digest', id: digestId('alice', 'pw') }],
    });
    const details = await readNode(ensemble.session, '/secret');
    expect(details).toEqual({
      stat: UNKNOWN_STAT,
      data: undefined,
      acl: [],
      children: [],
      moreChildren: false,
    });
  });

  it('lets another error through', async () => {
    await ensemble.close();
    await expect(readNode(ensemble.session, '/')).rejects.toBeInstanceOf(DbError);
    ensemble = await fakeEnsemble();
  });
});

describe('countTree', () => {
  beforeEach(() => {
    for (const path of ['/t/a/1', '/t/a/2', '/t/b/1', '/t/c']) {
      ensemble.server.seed(path);
    }
  });

  it('counts a subtree, its root included', async () => {
    expect(await countTree(ensemble.session, '/t')).toEqual({ count: 7, capped: false });
    expect(await countTree(ensemble.session, '/t/a')).toEqual({ count: 3, capped: false });
    expect(await countTree(ensemble.session, '/t/c')).toEqual({ count: 1, capped: false });
  });

  it('stops at the limit', async () => {
    expect(await countTree(ensemble.session, '/t', 5)).toEqual({ count: 5, capped: true });
  });

  it('stops when asked', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await countTree(ensemble.session, '/t', 100, controller.signal)).toEqual({
      count: 0,
      capped: true,
    });
  });

  it('counts a znode that is not there as one that has nothing below it', async () => {
    expect((await countTree(ensemble.session, '/missing')).count).toBe(1);
  });
});

describe('deleteTree', () => {
  it('deletes a subtree, children first, and says how many', async () => {
    for (const path of ['/t/a/1', '/t/a/2', '/t/b', '/keep']) {
      ensemble.server.seed(path);
    }
    expect(await deleteTree(ensemble.session, '/t')).toBe(5);
    expect(ensemble.server.nodes.has('/t')).toBe(false);
    expect(ensemble.server.nodes.has('/keep')).toBe(true);
  });

  it('counts only what it deleted when a part is gone already', async () => {
    ensemble.server.seed('/gone/x');
    const first = deleteTree(ensemble.session, '/gone');
    expect(await first).toBe(2);
    expect(await deleteTree(ensemble.session, '/gone')).toBe(0);
  });

  it('refuses to delete the root', async () => {
    await expect(deleteTree(ensemble.session, '/')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('stops between two levels when asked', async () => {
    ensemble.server.seed('/s/a/b');
    const controller = new AbortController();
    controller.abort();
    await expect(deleteTree(ensemble.session, '/s', controller.signal)).rejects.toMatchObject({
      code: 'cancelled',
    });
    expect(ensemble.server.nodes.has('/s/a/b')).toBe(true);
  });

  it('lets a refusal through', async () => {
    ensemble.server.seed('/guarded/child', '', {
      acl: [{ perms: 1, scheme: 'digest', id: digestId('alice', 'pw') }],
    });
    await expect(deleteTree(ensemble.session, '/guarded')).rejects.toMatchObject({
      code: 'permission-denied',
    });
  });
});
