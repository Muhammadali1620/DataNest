import { beforeEach, describe, expect, it } from 'vitest';
import type { EtcdSession } from '../../../../src/drivers/etcd-driver';
import {
  DEFAULT_KEYS_PER_LOAD,
  EtcdKeyBrowser,
  ROOT,
} from '../../../../src/services/etcd/key-browser';
import { RecordingLogger } from '../../../helpers/fakes';
import { FakeEtcd } from '../../../helpers/fake-etcd';

let etcd: FakeEtcd;
let acquired: { owner: string; connectionId: string }[];
let keysPerLoad: number | undefined;

function browser(): EtcdKeyBrowser {
  return new EtcdKeyBrowser({
    manager: {
      acquireEtcd: (owner, target) => {
        acquired.push({ owner, connectionId: target.connectionId });
        return Promise.resolve({ call: etcd.call } as unknown as EtcdSession);
      },
    },
    ...(keysPerLoad === undefined ? {} : { settings: { keysPerLoad: () => keysPerLoad ?? 0 } }),
    logger: new RecordingLogger(),
  });
}

const folder = (text: string): { text: string } => ({ text });

beforeEach(() => {
  etcd = new FakeEtcd();
  acquired = [];
  keysPerLoad = undefined;
  for (const name of ['/a/1', '/a/2', '/b']) {
    etcd.seed(name);
  }
});

describe('EtcdKeyBrowser', () => {
  it('reads a folder when it is first opened and not again', async () => {
    const keys = browser();
    const first = await keys.children('c1', folder('/a/'));
    expect(first.entries.map((entry) => entry.label)).toEqual(['1', '2']);
    expect(first.more).toBe(false);
    const reads = etcd.calls.length;
    await keys.children('c1', folder('/a/'));
    expect(etcd.calls.length).toBe(reads);
  });

  it('uses the tree session of the connection', async () => {
    await browser().children('c1', ROOT);
    expect(acquired).toEqual([{ owner: 'tree:c1', connectionId: 'c1' }]);
  });

  it('keeps each folder of each connection apart', async () => {
    const keys = browser();
    const a = await keys.children('c1', folder('/a/'));
    const root = await keys.children('c1', ROOT);
    const other = await keys.children('c2', folder('/a/'));
    expect(a.entries).toHaveLength(2);
    expect(root.entries).toHaveLength(1);
    expect(other.entries).toHaveLength(2);
    expect(acquired.map((one) => one.connectionId)).toEqual(['c1', 'c1', 'c2']);
  });

  it('shares one read between two openings at the same time', async () => {
    const keys = browser();
    const [one, two] = await Promise.all([
      keys.children('c1', folder('/a/')),
      keys.children('c1', folder('/a/')),
    ]);
    expect(one.entries).toHaveLength(2);
    expect(two.entries).toHaveLength(2);
    expect(acquired).toHaveLength(1);
  });

  it('brings the next page on request and adds it to the first', async () => {
    for (let index = 0; index < 2500; index += 1) {
      etcd.seed(`/big/k${String(index).padStart(4, '0')}`);
    }
    keysPerLoad = 1000;
    const keys = browser();
    const first = await keys.children('c1', folder('/big/'));
    expect(first.entries).toHaveLength(1000);
    expect(first.more).toBe(true);
    await keys.loadMore('c1', folder('/big/'));
    const second = await keys.children('c1', folder('/big/'));
    expect(second.entries).toHaveLength(2000);
    expect(second.more).toBe(true);
    await keys.loadMore('c1', folder('/big/'));
    const third = await keys.children('c1', folder('/big/'));
    expect(third.entries).toHaveLength(2500);
    expect(third.more).toBe(false);
    expect(new Set(third.entries.map((entry) => entry.label)).size).toBe(2500);
  });

  it('does nothing to load more of a folder that has no more', async () => {
    const keys = browser();
    await keys.children('c1', folder('/a/'));
    const reads = etcd.calls.length;
    await keys.loadMore('c1', folder('/a/'));
    expect(etcd.calls.length).toBe(reads);
    // Nor of a folder never opened.
    await keys.loadMore('c1', folder('/never/'));
    expect(etcd.calls.length).toBe(reads);
  });

  it('asks the setting at every read, so a change counts at once', async () => {
    for (let index = 0; index < 1500; index += 1) {
      etcd.seed(`/set/k${String(index).padStart(4, '0')}`);
    }
    keysPerLoad = 1;
    const keys = browser();
    const first = await keys.children('c1', folder('/set/'));
    // The read-ahead is 1000 keys, so a page of one still brings the whole read.
    expect(first.entries).toHaveLength(1000);
    keysPerLoad = 5000;
    await keys.loadMore('c1', folder('/set/'));
    expect((await keys.children('c1', folder('/set/'))).entries).toHaveLength(1500);
  });

  it('has a page size of its own when no setting is given', () => {
    expect(DEFAULT_KEYS_PER_LOAD).toBe(300);
  });

  it('forgets one connection or all, so the next look asks again', async () => {
    const keys = browser();
    await keys.children('c1', folder('/a/'));
    await keys.children('c2', folder('/a/'));
    keys.reset('c1');
    const reads = etcd.calls.length;
    await keys.children('c2', folder('/a/'));
    expect(etcd.calls.length).toBe(reads);
    await keys.children('c1', folder('/a/'));
    expect(etcd.calls.length).toBeGreaterThan(reads);
    keys.reset();
    const after = etcd.calls.length;
    await keys.children('c2', folder('/a/'));
    expect(etcd.calls.length).toBeGreaterThan(after);
  });

  it('does not mix up a connection id that starts like another', async () => {
    const keys = browser();
    await keys.children('c1', folder('/a/'));
    await keys.children('c10', folder('/a/'));
    keys.reset('c1');
    const reads = etcd.calls.length;
    await keys.children('c10', folder('/a/'));
    expect(etcd.calls.length).toBe(reads);
  });

  it('forgets a read that failed, so opening the folder again tries again', async () => {
    const keys = browser();
    etcd.failNext = { status: 503, body: { code: 14, message: 'etcdserver: no leader' } };
    await expect(keys.children('c1', folder('/a/'))).rejects.toThrow(/no leader/u);
    const again = await keys.children('c1', folder('/a/'));
    expect(again.entries).toHaveLength(2);
  });

  it('shows a folder that is empty as empty and asks again next time', async () => {
    const keys = browser();
    expect((await keys.children('c1', folder('/empty/'))).entries).toEqual([]);
    etcd.seed('/empty/now');
    expect((await keys.children('c1', folder('/empty/'))).entries).toHaveLength(1);
  });
});
