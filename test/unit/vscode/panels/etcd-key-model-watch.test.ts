import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { toBase64 } from '../../../../src/services/etcd/etcd-codec';
import { redisKeyRef } from '../../../../src/shared/redis-key';
import { EtcdKeyModel, MAX_WATCH_EVENTS } from '../../../../src/vscode/panels/etcd-key-model';
import { FakeEtcd } from '../../../helpers/fake-etcd';

let etcd: FakeEtcd;

beforeEach(() => {
  etcd = new FakeEtcd();
});

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function model(key: string, session: () => Promise<FakeEtcd> = () => Promise.resolve(etcd)) {
  return new EtcdKeyModel({
    key: redisKeyRef(bytes(key)),
    connectionName: 'etcd one',
    readOnly: false,
    session,
    watchFlushMs: 5,
  });
}

function put(key: string, value: string | Uint8Array): Promise<unknown> {
  return etcd.call('kv/put', {
    key: toBase64(bytes(key)),
    value: toBase64(typeof value === 'string' ? bytes(value) : value),
  });
}

describe('watching a key', () => {
  it('shows a key as not watched until it is', async () => {
    const state = await model('/k').refresh();
    expect(state.watching).toBeUndefined();
    expect(state.events).toBeUndefined();
    expect(state.watchNotice).toBeUndefined();
  });

  it('starts, reads the key once the cluster has the watch, and says it is watching', async () => {
    etcd.seed('/k', 'one');
    const changed = vi.fn();
    const watched = model('/k');
    const started = await watched.startWatch(false, changed);
    expect(started).toMatchObject({ watching: true, watchPrefix: false });
    expect(watched.watching).toBe(true);
    // The read that closes the gap between the page's read and the watch.
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalled();
    });
    expect(watched.state()).toMatchObject({ exists: true, value: { text: 'one' } });
    watched.stopWatch();
  });

  it('follows the key: a put is listed and the value shown is the new one', async () => {
    etcd.seed('/k', 'one');
    const changed = vi.fn();
    const watched = model('/k');
    await watched.startWatch(false, changed);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    await put('/k', 'two');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    const state = watched.state();
    expect(state.value).toEqual({ text: 'two' });
    expect(state.version).toBe(2);
    expect(state.events?.[0]).toMatchObject({ type: 'put', key: '/k', size: 3, preview: 'two' });
    expect(Number(state.events?.[0]?.revision)).toBeGreaterThan(1);
    watched.stopWatch();
  });

  it('shows a key that appears while the page showed it as missing', async () => {
    const watched = model('/later');
    const changed = vi.fn();
    await watched.startWatch(false, changed);
    await put('/later', 'here');
    await vi.waitFor(() => {
      expect(watched.state().exists).toBe(true);
    });
    expect(watched.state().events?.[0]).toMatchObject({ type: 'put', key: '/later' });
    watched.stopWatch();
  });

  it('lists a delete and shows the key as gone', async () => {
    etcd.seed('/k', 'one');
    const watched = model('/k');
    await watched.startWatch(false, vi.fn());
    await vi.waitFor(() => {
      expect(watched.state().exists).toBe(true);
    });
    await etcd.call('kv/deleterange', { key: toBase64(bytes('/k')) });
    await vi.waitFor(() => {
      expect(watched.state().exists).toBe(false);
    });
    expect(watched.state().events?.[0]).toMatchObject({ type: 'delete', size: 0, preview: '' });
    watched.stopWatch();
  });

  it('gathers changes that come close together into one call', async () => {
    etcd.seed('/k', 'a');
    const changed = vi.fn();
    const watched = model('/k');
    await watched.startWatch(false, changed);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    await put('/k', 'b');
    await put('/k', 'c');
    await put('/k', 'd');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(3);
    });
    expect(changed).toHaveBeenCalledTimes(2);
    expect(watched.state().value).toEqual({ text: 'd' });
    watched.stopWatch();
  });

  it('with a prefix, lists the keys below and still follows the key itself', async () => {
    etcd.seed('/k', 'a');
    const watched = model('/k');
    await watched.startWatch(true, vi.fn());
    expect(watched.state().watchPrefix).toBe(true);
    await put('/k/child', 'x');
    await put('/k', 'b');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(2);
    });
    expect(watched.state().events?.map((event) => event.key)).toEqual(['/k/child', '/k']);
    expect(watched.state().value).toEqual({ text: 'b' });
    watched.stopWatch();
  });

  it('does not read the key again for a change of another key', async () => {
    etcd.seed('/k', 'a');
    const watched = model('/k');
    await watched.startWatch(true, vi.fn());
    await vi.waitFor(() => {
      expect(etcd.calls.filter((path) => path === 'kv/range').length).toBeGreaterThan(0);
    });
    const reads = (): number => etcd.calls.filter((path) => path === 'kv/range').length;
    const before = reads();
    const changed = vi.fn();
    watched.stopWatch();
    const again = model('/k');
    await again.startWatch(true, changed);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalled();
    });
    const afterStart = reads();
    expect(afterStart).toBeGreaterThan(before);
    await put('/k/other', 'x');
    await vi.waitFor(() => {
      expect(again.state().events).toHaveLength(1);
    });
    expect(reads()).toBe(afterStart);
    again.stopWatch();
  });

  it('shows text that is not UTF-8 as hex in the list', async () => {
    const watched = model('/bin');
    await watched.startWatch(false, vi.fn());
    await put('/bin', Uint8Array.of(0xff, 0xfe, 0x00, 0x41));
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    expect(watched.state().events?.[0]).toMatchObject({ size: 4, preview: '0xfffe0041' });
    watched.stopWatch();
  });

  it('cuts a long hex preview and a long text preview', async () => {
    const watched = model('/long');
    await watched.startWatch(false, vi.fn());
    await put('/long', 'x'.repeat(500));
    await put('/long', new Uint8Array(100).fill(0xff));
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(2);
    });
    const [text, binary] = watched.state().events ?? [];
    expect(text?.preview).toBe(`${'x'.repeat(200)}…`);
    expect(binary?.preview).toBe(`0x${'ff'.repeat(32)}…`);
    watched.stopWatch();
  });

  it('keeps the newest changes only', async () => {
    const watched = model('/many');
    await watched.startWatch(false, vi.fn());
    for (let index = 0; index < MAX_WATCH_EVENTS + 20; index += 1) {
      await put('/many', `v${index}`);
    }
    await vi.waitFor(() => {
      expect(watched.state().value).toEqual({ text: `v${MAX_WATCH_EVENTS + 19}` });
    });
    watched.stopWatch();
    const events = watched.state().events ?? [];
    expect(events).toHaveLength(MAX_WATCH_EVENTS);
    expect(events.at(-1)?.preview).toBe(`v${MAX_WATCH_EVENTS + 19}`);
  });

  it('stops: nothing more is listed, what was seen stays', async () => {
    const watched = model('/k');
    await watched.startWatch(false, vi.fn());
    await put('/k', 'one');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    const stopped = watched.stopWatch();
    expect(stopped.watching).toBeUndefined();
    expect(stopped.events).toHaveLength(1);
    expect(watched.watching).toBe(false);
    await put('/k', 'two');
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(watched.state().events).toHaveLength(1);
  });

  it('puts the changes gathered at the moment of stopping in the list', async () => {
    const watched = new EtcdKeyModel({
      key: redisKeyRef(bytes('/k')),
      connectionName: 'c',
      readOnly: false,
      session: () => Promise.resolve(etcd),
      watchFlushMs: 10_000,
    });
    await watched.startWatch(false, vi.fn());
    await put('/k', 'one');
    expect(watched.state().events).toBeUndefined();
    expect(watched.stopWatch().events).toHaveLength(1);
  });

  it('stopping a watch that never started is harmless', () => {
    expect(model('/k').stopWatch().watching).toBeUndefined();
  });

  it('starting again replaces the watch', async () => {
    const watched = model('/k');
    await watched.startWatch(false, vi.fn());
    await watched.startWatch(true, vi.fn());
    expect(watched.state().watchPrefix).toBe(true);
    await put('/k/x', 'a');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    watched.stopWatch();
  });

  it('clears the list', async () => {
    const watched = model('/k');
    await watched.startWatch(false, vi.fn());
    await put('/k', 'one');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    const cleared = watched.clearEvents();
    expect(cleared.events).toBeUndefined();
    expect(cleared.watching).toBe(true);
    watched.stopWatch();
  });

  it('says so when the cluster ends the watch, and keeps what was seen', async () => {
    const watched = model('/k');
    const changed = vi.fn();
    await watched.startWatch(false, changed);
    await put('/k', 'one');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    changed.mockClear();
    etcd.cancelWatches('etcdserver: mvcc: required revision has been compacted');
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalled();
    });
    const state = watched.state();
    expect(state.watching).toBeUndefined();
    expect(state.watchNotice).toContain('compacted');
    expect(state.events).toHaveLength(1);
    expect(watched.watching).toBe(false);
  });

  it('says so when the stream ends on its own', async () => {
    const session = {
      call: etcd.call.bind(etcd),
      watch: () => Promise.resolve(),
    };
    const watched = new EtcdKeyModel({
      key: redisKeyRef(bytes('/k')),
      connectionName: 'c',
      readOnly: false,
      session: () => Promise.resolve(session),
    });
    const changed = vi.fn();
    await watched.startWatch(false, changed);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalled();
    });
    expect(watched.state().watchNotice).toContain('The cluster closed the watch');
    expect(watched.watching).toBe(false);
  });

  it('says so when the link breaks', async () => {
    const watched = model('/k');
    const changed = vi.fn();
    etcd.failNextWatch = 'etcdserver: permission denied';
    await watched.startWatch(false, changed);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalled();
    });
    expect(watched.state().watchNotice).toBe('Watching stopped: etcdserver: permission denied');
    expect(watched.watching).toBe(false);
  });

  it('says so when the key cannot be read after a change', async () => {
    etcd.seed('/k', 'one');
    const watched = model('/k');
    const changed = vi.fn();
    await watched.startWatch(false, changed);
    await vi.waitFor(() => {
      expect(changed).toHaveBeenCalledTimes(1);
    });
    await put('/k', 'two');
    etcd.failNext = { status: 503, body: { code: 14, message: 'etcdserver: no leader' } };
    await vi.waitFor(() => {
      expect(watched.state().watchNotice).toContain('no leader');
    });
    expect(watched.watching).toBe(false);
  });

  it('does not watch through a session that cannot', async () => {
    const watched = new EtcdKeyModel({
      key: redisKeyRef(bytes('/k')),
      connectionName: 'c',
      readOnly: false,
      session: () => Promise.resolve({ call: etcd.call.bind(etcd) }),
    });
    const error = await watched.startWatch(false, vi.fn()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('unsupported');
    expect(watched.watching).toBe(false);
  });

  it('watches a connection that is read-only too: watching changes nothing', async () => {
    etcd.seed('/k', 'one');
    const watched = new EtcdKeyModel({
      key: redisKeyRef(bytes('/k')),
      connectionName: 'c',
      readOnly: true,
      session: () => Promise.resolve(etcd),
    });
    expect((await watched.startWatch(false, vi.fn())).watching).toBe(true);
    watched.stopWatch();
  });
});
