import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { ConnectionManager } from '../../../../src/services/connection-manager';
import { RedisKeyBrowser } from '../../../../src/services/redis/key-browser';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';
import { RecordingLogger } from '../../../helpers/fakes';

function setup(keyspace: string[][], options: { perLoad?: number } = {}) {
  const session = new FakeRedisSession((words) => (words[0] === 'TYPE' ? bulk('string') : null));
  session.keyspace = keyspace;
  const acquired: { owner: string; database?: string }[] = [];
  let separator = ':';
  const browser = new RedisKeyBrowser({
    manager: {
      acquireRedis: (owner, target) => {
        acquired.push({
          owner,
          ...(target.database === undefined ? {} : { database: target.database }),
        });
        return Promise.resolve(session);
      },
    },
    settings: { separator: () => separator, keysPerLoad: () => options.perLoad ?? 5000 },
    logger: new RecordingLogger(),
  });
  return {
    browser,
    session,
    acquired,
    setSeparator: (next: string) => {
      separator = next;
    },
  };
}

describe('RedisKeyBrowser', () => {
  it('loads on the first look, on the tree session of that database', async () => {
    const { browser, acquired, session } = setup([['user:1', 'user:2', 'app']]);
    const top = await browser.children('c1', 3, []);
    expect(top.folders).toEqual([{ name: 'user', path: ['user'], count: 2 }]);
    expect(top.keys.map((leaf) => leaf.name)).toEqual(['app']);
    expect(top).toMatchObject({ more: false, loaded: 3, pattern: undefined });
    expect(acquired).toEqual([{ owner: ConnectionManager.treeOwner('c1', '3'), database: '3' }]);
    await browser.children('c1', 3, ['user']);
    // Looking again does not scan again.
    expect(session.scans).toHaveLength(1);
  });

  it('brings one portion at a time and says when there is more', async () => {
    const keys = Array.from({ length: 2500 }, (_value, index) => `k:${index}`);
    const { browser } = setup([keys], { perLoad: 1000 });
    expect(await browser.children('c1', 0, [])).toMatchObject({ more: true, loaded: 1000 });
    await browser.loadMore('c1', 0);
    expect(await browser.children('c1', 0, [])).toMatchObject({ more: true, loaded: 2000 });
    await browser.loadMore('c1', 0);
    expect(await browser.children('c1', 0, [])).toMatchObject({ more: false, loaded: 2500 });
  });

  it('shares one load between callers at the same time', async () => {
    const { browser, session } = setup([['a', 'b']]);
    await Promise.all([
      browser.children('c1', 0, []),
      browser.children('c1', 0, []),
      browser.loadMore('c1', 0),
    ]);
    expect(session.scans).toHaveLength(1);
  });

  it('filters by a pattern and starts over when it changes', async () => {
    const { browser, session } = setup([['user:1', 'app:1']]);
    await browser.children('c1', 0, []);
    browser.setPattern('c1', 0, ' user:* ');
    expect(browser.patternOf('c1', 0)).toBe('user:*');
    const filtered = await browser.children('c1', 0, []);
    expect(filtered.folders.map((folder) => folder.name)).toEqual(['user']);
    expect(filtered.pattern).toBe('user:*');
    expect(session.scans.at(-1)?.match).toBe('user:*');
    for (const all of ['', '*', '   ', undefined]) {
      browser.setPattern('c1', 0, all);
      expect(browser.patternOf('c1', 0)).toBeUndefined();
    }
  });

  it('keeps databases and connections apart', () => {
    const { browser } = setup([['a']]);
    browser.setPattern('c1', 1, 'x*');
    expect(browser.patternOf('c1', 0)).toBeUndefined();
    expect(browser.patternOf('c2', 1)).toBeUndefined();
  });

  it('forgets loaded keys on reset but keeps the filter', async () => {
    const { browser, session } = setup([['a', 'b']]);
    browser.setPattern('c1', 0, 'a*');
    await browser.children('c1', 0, []);
    await browser.children('c1', 1, []);
    browser.reset('c1', 0);
    await browser.children('c1', 0, []);
    await browser.children('c1', 1, []);
    expect(session.scans).toHaveLength(3);
    expect(browser.patternOf('c1', 0)).toBe('a*');
    browser.reset();
    await browser.children('c1', 1, []);
    expect(session.scans).toHaveLength(4);
  });

  it('drops what a load read after a reset came in between', async () => {
    const { browser, session } = setup([['a']]);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = session.scanStep.bind(session);
    session.scanStep = async (...args) => {
      await gate;
      return await original(...args);
    };
    const loading = browser.children('c1', 0, []);
    browser.reset('c1');
    release();
    await loading;
    // The old load found keys but put none of them into the fresh state.
    session.keyspace = [[]];
    session.scanStep = original;
    expect((await browser.children('c1', 0, [])).loaded).toBe(0);
  });

  it('regroups loaded keys when the separator changes, without loading again', async () => {
    const { browser, session, setSeparator } = setup([['a:b/c']]);
    expect((await browser.children('c1', 0, [])).folders.map((folder) => folder.name)).toEqual([
      'a',
    ]);
    setSeparator('/');
    expect((await browser.children('c1', 0, [])).folders.map((folder) => folder.name)).toEqual([
      'a:b',
    ]);
    expect(browser.folderOf('c1', 0, { text: 'a:b/c' })).toEqual(['a:b']);
    expect(session.scans).toHaveLength(1);
  });

  it('takes in a key found elsewhere and forgets a deleted one', async () => {
    const { browser } = setup([[]]);
    await browser.children('c1', 0, []);
    browser.include('c1', 0, { key: { text: 'found:1' }, type: 'hash' });
    expect((await browser.children('c1', 0, ['found'])).keys[0]?.entry.type).toBe('hash');
    browser.forget('c1', 0, { text: 'found:1' });
    expect((await browser.children('c1', 0, [])).folders).toEqual([]);
  });

  it('passes a failed load on and tries again next time', async () => {
    const { browser, session } = setup([['a']]);
    session.scanError = new DbError('connection-failed', 'gone');
    await expect(browser.children('c1', 0, [])).rejects.toMatchObject({
      code: 'connection-failed',
    });
    session.scanError = undefined;
    expect((await browser.children('c1', 0, [])).loaded).toBe(1);
  });
});
