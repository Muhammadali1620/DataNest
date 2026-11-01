import { describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { ConnectionManager } from '../../../../src/services/connection-manager';
import { RedisKeyBrowser } from '../../../../src/services/redis/key-browser';
import { COUNT_BUDGET_MS, COUNT_CAP, countKeys } from '../../../../src/services/redis/key-scan';
import { bulk, FakeRedisSession } from '../../../helpers/fake-redis';
import { RecordingLogger } from '../../../helpers/fakes';

const names = (count: number, prefix = 'k'): string[] =>
  Array.from({ length: count }, (_value, index) => `${prefix}:${index}`);

function typed(): FakeRedisSession {
  return new FakeRedisSession((words) => (words[0] === 'TYPE' ? bulk('string') : null));
}

describe('countKeys', () => {
  it('counts every key that matches, walking in small steps', async () => {
    const session = typed();
    session.keyspace = [[...names(2500, 'user'), ...names(300, 'app')]];
    const result = await countKeys(session, { match: 'user:*', cap: 100_000, budgetMs: 10_000 });
    expect(result).toEqual({ count: 2500, complete: true, cancelled: false });
    expect(session.scans.map((scan) => scan.count)).toEqual([1000, 1000, 1000]);
    expect(session.scans.every((scan) => scan.match === 'user:*')).toBe(true);
    // Only SCAN: the server is never asked for KEYS.
    expect(session.calls).toEqual([]);
  });

  it('counts a key once even when SCAN returns it twice', async () => {
    const session = typed();
    session.keyspace = [['a', 'a', 'b', 'a']];
    expect((await countKeys(session, { cap: 10, budgetMs: 1000 })).count).toBe(2);
  });

  it('adds up the masters of a cluster', async () => {
    const session = typed();
    session.keyspace = [['a'], [], ['b', 'c']];
    const result = await countKeys(session, { cap: 10, budgetMs: 1000 });
    expect(result).toMatchObject({ count: 3, complete: true });
    expect(session.scans.map((scan) => scan.master)).toEqual([0, 1, 2]);
  });

  it('counts nothing in an empty database', async () => {
    const session = typed();
    expect(await countKeys(session, { cap: 10, budgetMs: 1000 })).toEqual({
      count: 0,
      complete: true,
      cancelled: false,
    });
  });

  it('stops at the cap and says the number is only a lower bound', async () => {
    const session = typed();
    session.keyspace = [names(5000)];
    const result = await countKeys(session, { cap: 1500, budgetMs: 10_000 });
    expect(result).toEqual({ count: 2000, complete: false, cancelled: false });
    expect(session.scans).toHaveLength(2);
  });

  it('is exact when the cap is reached by the very last step', async () => {
    const session = typed();
    session.keyspace = [names(1000)];
    expect(await countKeys(session, { cap: 1000, budgetMs: 1000 })).toMatchObject({
      count: 1000,
      complete: true,
    });
  });

  it('stops at the time budget', async () => {
    const session = typed();
    session.keyspace = [names(5000)];
    let clock = 0;
    const result = await countKeys(session, {
      cap: 100_000,
      budgetMs: 100,
      now: () => (clock += 60),
    });
    expect(result.complete).toBe(false);
    expect(result.count).toBeLessThan(5000);
  });

  it('stops between steps when cancelled and keeps what it saw', async () => {
    const session = typed();
    session.keyspace = [names(5000)];
    const signal = { aborted: false };
    const result = await countKeys(session, {
      cap: 100_000,
      budgetMs: 10_000,
      signal,
      onProgress: () => {
        signal.aborted = true;
      },
    });
    expect(result).toEqual({ count: 1000, complete: false, cancelled: true });
    expect(session.scans).toHaveLength(1);
  });

  it('is cancelled before the first step when already cancelled', async () => {
    const session = typed();
    session.keyspace = [names(10)];
    const result = await countKeys(session, { cap: 10, budgetMs: 10, signal: { aborted: true } });
    expect(result).toEqual({ count: 0, complete: false, cancelled: true });
    expect(session.scans).toHaveLength(0);
  });

  it('reports the climb after each step', async () => {
    const session = typed();
    session.keyspace = [names(2500)];
    const seen: number[] = [];
    await countKeys(session, { cap: 100_000, budgetMs: 10_000, onProgress: (n) => seen.push(n) });
    expect(seen).toEqual([1000, 2000, 2500]);
  });

  it('passes a failure of the server on', async () => {
    const session = typed();
    session.scanError = new DbError('permission-denied', 'NOPERM');
    await expect(countKeys(session, { cap: 10, budgetMs: 10 })).rejects.toThrow('NOPERM');
  });

  it('has a cap and a budget that suit a tree', () => {
    expect(COUNT_CAP).toBe(100_000);
    expect(COUNT_BUDGET_MS).toBe(30_000);
  });
});

function setup(keyspace: string[][]) {
  const session = typed();
  session.keyspace = keyspace;
  const browser = new RedisKeyBrowser({
    manager: { acquireRedis: () => Promise.resolve(session) },
    settings: { separator: () => ':', keysPerLoad: () => 5000 },
    logger: new RecordingLogger(),
  });
  return { browser, session };
}

describe('RedisKeyBrowser: counting a folder (V13.7)', () => {
  const keyspace = [['user:1', 'user:2', 'user:3:x', 'users', 'app:1']];

  it('counts the keys under a prefix, not the ones that merely start alike', async () => {
    const { browser, session } = setup(keyspace);
    expect(browser.countOf('c1', 0, 'user:')).toBeUndefined();
    const counted = await browser.countFolder('c1', 0, 'user:');
    expect(counted).toEqual({ state: 'counted', count: 3, exact: true });
    expect(browser.countOf('c1', 0, 'user:')).toEqual(counted);
    expect(session.scans[0]?.match).toBe('user:*');
  });

  it('writes a prefix with glob characters as itself', async () => {
    const { browser, session } = setup([['a*b:1', 'axb:1', 'a*b:2']]);
    expect(await browser.countFolder('c1', 0, 'a*b:')).toMatchObject({ count: 2 });
    expect(session.scans[0]?.match).toBe('a\\*b:*');
  });

  it('keeps the number until the tree is refreshed', async () => {
    const { browser } = setup(keyspace);
    await browser.countFolder('c1', 0, 'user:');
    await browser.children('c1', 0, []);
    expect(browser.countOf('c1', 0, 'user:')).toMatchObject({ count: 3 });
    browser.reset('c1', 0);
    expect(browser.countOf('c1', 0, 'user:')).toBeUndefined();
  });

  it('keeps counts of other databases, connections and prefixes apart', async () => {
    const { browser } = setup(keyspace);
    await browser.countFolder('c1', 0, 'user:');
    expect(browser.countOf('c1', 1, 'user:')).toBeUndefined();
    expect(browser.countOf('c2', 0, 'user:')).toBeUndefined();
    expect(browser.countOf('c1', 0, 'app:')).toBeUndefined();
  });

  it('shares one count between callers at the same time', async () => {
    const { browser, session } = setup(keyspace);
    const [a, b] = await Promise.all([
      browser.countFolder('c1', 0, 'user:'),
      browser.countFolder('c1', 0, 'user:'),
    ]);
    expect(a).toEqual(b);
    expect(session.scans).toHaveLength(1);
  });

  it('shows the climb while it counts', async () => {
    const { browser } = setup([names(2500, 'u')]);
    const during: unknown[] = [];
    await browser.countFolder('c1', 0, 'u:', {
      onProgress: () => during.push(browser.countOf('c1', 0, 'u:')),
    });
    expect(during).toEqual([
      { state: 'counting', found: 1000 },
      { state: 'counting', found: 2000 },
      { state: 'counting', found: 2500 },
    ]);
  });

  it('says "at least" when the count stopped at its cap', async () => {
    const { browser } = setup([names(5000, 'u')]);
    expect(await browser.countFolder('c1', 0, 'u:', { cap: 1500 })).toEqual({
      state: 'counted',
      count: 2000,
      exact: false,
    });
  });

  it('forgets a cancelled count instead of remembering a number', async () => {
    const { browser } = setup([names(5000, 'u')]);
    const signal = { aborted: false };
    const result = await browser.countFolder('c1', 0, 'u:', {
      signal,
      onProgress: () => {
        signal.aborted = true;
      },
    });
    expect(result).toBeUndefined();
    expect(browser.countOf('c1', 0, 'u:')).toBeUndefined();
    // Counting again starts clean.
    expect(await browser.countFolder('c1', 0, 'u:')).toMatchObject({ count: 5000, exact: true });
  });

  it('forgets a count that failed, and passes the failure on', async () => {
    const { browser, session } = setup(keyspace);
    session.scanError = new DbError('permission-denied', 'NOPERM');
    await expect(browser.countFolder('c1', 0, 'user:')).rejects.toThrow('NOPERM');
    expect(browser.countOf('c1', 0, 'user:')).toBeUndefined();
    session.scanError = undefined;
    expect(await browser.countFolder('c1', 0, 'user:')).toMatchObject({ count: 3 });
  });

  it('drops a number that arrives after the tree was refreshed', async () => {
    const { browser } = setup(keyspace);
    await browser.countFolder('c1', 0, 'user:', {
      onProgress: () => {
        browser.reset('c1', 0);
      },
    });
    expect(browser.countOf('c1', 0, 'user:')).toBeUndefined();
  });

  it('does not mark the database as loaded: the first look still loads', async () => {
    const { browser } = setup(keyspace);
    await browser.countFolder('c1', 0, 'user:');
    expect((await browser.children('c1', 0, [])).loaded).toBe(5);
  });

  it('uses the tree session of the database', async () => {
    const owners: string[] = [];
    const session = typed();
    const browser = new RedisKeyBrowser({
      manager: {
        acquireRedis: (owner) => {
          owners.push(owner);
          return Promise.resolve(session);
        },
      },
      settings: { separator: () => ':', keysPerLoad: () => 10 },
      logger: new RecordingLogger(),
    });
    await browser.countFolder('c1', 3, 'x:');
    expect(owners).toEqual([ConnectionManager.treeOwner('c1', '3')]);
  });
});
