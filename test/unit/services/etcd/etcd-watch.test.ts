import { describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { toBase64 } from '../../../../src/services/etcd/etcd-codec';
import { watchKeys, type EtcdWatchEvent } from '../../../../src/services/etcd/etcd-watch';
import { FakeEtcd } from '../../../helpers/fake-etcd';

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

/** Opens a watch on the fake cluster and collects what it reports. */
function open(
  etcd: FakeEtcd,
  key: string,
  options: { prefix?: boolean; startRevision?: string } = {},
): {
  events: EtcdWatchEvent[];
  created: ReturnType<typeof vi.fn>;
  stop: () => void;
  done: Promise<void>;
} {
  const events: EtcdWatchEvent[] = [];
  const created = vi.fn();
  const abort = new AbortController();
  const done = watchKeys(
    etcd,
    bytes(key),
    { ...options, onCreated: created },
    (batch) => {
      events.push(...batch);
    },
    abort.signal,
  );
  return {
    events,
    created,
    stop: () => {
      abort.abort();
    },
    done,
  };
}

describe('watchKeys', () => {
  it('asks the gateway for the key, with the previous value', async () => {
    const etcd = new FakeEtcd();
    const bodies: Record<string, unknown>[] = [];
    const watcher = {
      watch: (_path: string, body: Readonly<Record<string, unknown>>) => {
        bodies.push({ ...body });
        return Promise.resolve();
      },
    };
    await watchKeys(watcher, bytes('/a'), {}, () => undefined, new AbortController().signal);
    expect(bodies).toEqual([{ create_request: { key: toBase64(bytes('/a')), prev_kv: true } }]);
    expect(etcd.revision).toBe(1);
  });

  it('asks for a prefix with the end of its range, and for a revision to start at', async () => {
    const bodies: Record<string, unknown>[] = [];
    const watcher = {
      watch: (_path: string, body: Readonly<Record<string, unknown>>) => {
        bodies.push({ ...body });
        return Promise.resolve();
      },
    };
    await watchKeys(
      watcher,
      bytes('/a/'),
      { prefix: true, startRevision: '42' },
      () => undefined,
      new AbortController().signal,
    );
    expect(bodies[0]).toEqual({
      create_request: {
        key: toBase64(bytes('/a/')),
        range_end: toBase64(bytes('/a0')),
        start_revision: '42',
        prev_kv: true,
      },
    });
  });

  it('starts an empty prefix at the very first key', async () => {
    const bodies: Record<string, unknown>[] = [];
    const watcher = {
      watch: (_path: string, body: Readonly<Record<string, unknown>>) => {
        bodies.push({ ...body });
        return Promise.resolve();
      },
    };
    await watchKeys(
      watcher,
      new Uint8Array(),
      { prefix: true },
      () => undefined,
      new AbortController().signal,
    );
    expect(bodies[0]).toMatchObject({
      create_request: { key: toBase64(Uint8Array.of(0)), range_end: toBase64(Uint8Array.of(0)) },
    });
  });

  it('says when the cluster has accepted the watch', async () => {
    const etcd = new FakeEtcd();
    const watch = open(etcd, '/a');
    expect(watch.created).toHaveBeenCalledTimes(1);
    watch.stop();
    await watch.done;
  });

  it('reports a put with its value, its previous value and its revision', async () => {
    const etcd = new FakeEtcd();
    etcd.seed('/a', 'one');
    const watch = open(etcd, '/a');
    await etcd.call('kv/put', { key: toBase64(bytes('/a')), value: toBase64(bytes('two')) });
    watch.stop();
    await watch.done;
    expect(watch.events).toHaveLength(1);
    const [event] = watch.events;
    expect(event).toMatchObject({ type: 'put', version: 2 });
    expect(text(event?.key ?? new Uint8Array())).toBe('/a');
    expect(text(event?.value ?? new Uint8Array())).toBe('two');
    expect(text(event?.previous ?? new Uint8Array())).toBe('one');
    expect(Number(event?.modRevision)).toBeGreaterThan(1);
  });

  it('reports a new key without a previous value', async () => {
    const etcd = new FakeEtcd();
    const watch = open(etcd, '/new');
    await etcd.call('kv/put', { key: toBase64(bytes('/new')), value: toBase64(bytes('x')) });
    watch.stop();
    await watch.done;
    expect(watch.events[0]).toMatchObject({ type: 'put', version: 1 });
    expect(watch.events[0]?.previous).toBeUndefined();
  });

  it('reports a delete with an empty value and the value it had', async () => {
    const etcd = new FakeEtcd();
    etcd.seed('/a', 'bye');
    const watch = open(etcd, '/a');
    await etcd.call('kv/deleterange', { key: toBase64(bytes('/a')) });
    watch.stop();
    await watch.done;
    const [event] = watch.events;
    expect(event).toMatchObject({ type: 'delete', version: 0 });
    expect(event?.value).toEqual(new Uint8Array());
    expect(text(event?.previous ?? new Uint8Array())).toBe('bye');
  });

  it('ignores other keys when one key is watched', async () => {
    const etcd = new FakeEtcd();
    const watch = open(etcd, '/a');
    await etcd.call('kv/put', { key: toBase64(bytes('/ab')), value: toBase64(bytes('x')) });
    await etcd.call('kv/put', { key: toBase64(bytes('/a/b')), value: toBase64(bytes('x')) });
    watch.stop();
    await watch.done;
    expect(watch.events).toEqual([]);
  });

  it('sees every key below a prefix and none outside it', async () => {
    const etcd = new FakeEtcd();
    const watch = open(etcd, '/a/', { prefix: true });
    for (const name of ['/a/1', '/a/2/deep', '/b/1']) {
      await etcd.call('kv/put', { key: toBase64(bytes(name)), value: toBase64(bytes('x')) });
    }
    watch.stop();
    await watch.done;
    expect(watch.events.map((event) => text(event.key))).toEqual(['/a/1', '/a/2/deep']);
  });

  it('sees the keys a revoked lease takes with it', async () => {
    const etcd = new FakeEtcd();
    const watch = open(etcd, '/leased');
    const lease = (await etcd.call('lease/grant', { TTL: '60' })) as { ID: string };
    await etcd.call('kv/put', {
      key: toBase64(bytes('/leased')),
      value: toBase64(bytes('x')),
      lease: lease.ID,
    });
    await etcd.call('lease/revoke', { ID: lease.ID });
    watch.stop();
    await watch.done;
    expect(watch.events.map((event) => event.type)).toEqual(['put', 'delete']);
  });

  it('ends quietly when it is stopped, and then hears nothing more', async () => {
    const etcd = new FakeEtcd();
    const watch = open(etcd, '/a');
    watch.stop();
    await expect(watch.done).resolves.toBeUndefined();
    await etcd.call('kv/put', { key: toBase64(bytes('/a')), value: toBase64(bytes('x')) });
    expect(watch.events).toEqual([]);
  });

  it('fails with the reason when the cluster cancels the watch', async () => {
    const etcd = new FakeEtcd();
    const watch = open(etcd, '/a');
    const failure = watch.done.catch((error: unknown) => error);
    etcd.cancelWatches('etcdserver: mvcc: required revision has been compacted');
    const error = await failure;
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('constraint');
    expect((error as DbError).message).toContain('compacted');
  });

  it('gives a cancelled watch without a reason a reason of its own', async () => {
    const watcher = {
      watch: (_path: string, _body: unknown, onMessage: (message: unknown) => void) => {
        onMessage({ result: { canceled: true } });
        return Promise.resolve();
      },
    };
    await expect(
      watchKeys(watcher, bytes('/a'), {}, () => undefined, new AbortController().signal),
    ).rejects.toThrow('The cluster ended the watch');
  });

  it('names the revision the history was compacted to when the cluster says no more', async () => {
    const watcher = {
      watch: (_path: string, _body: unknown, onMessage: (message: unknown) => void) => {
        onMessage({ result: { canceled: true, compact_revision: '57' } });
        return Promise.resolve();
      },
    };
    await expect(
      watchKeys(watcher, bytes('/a'), {}, () => undefined, new AbortController().signal),
    ).rejects.toThrow('The history up to revision 57 was compacted: watch from a later revision');
  });

  it.each([
    [7, 'permission-denied'],
    [16, 'auth-failed'],
    [14, 'busy'],
    [3, 'syntax'],
    [13, 'constraint'],
  ])('reads an error message of gRPC code %i as %s', async (code, kind) => {
    const watcher = {
      watch: (_path: string, _body: unknown, onMessage: (message: unknown) => void) => {
        onMessage({ error: { code, message: 'nope' } });
        return Promise.resolve();
      },
    };
    const error = await watchKeys(
      watcher,
      bytes('/a'),
      {},
      () => undefined,
      new AbortController().signal,
    ).catch((failure: unknown) => failure);
    expect(error).toMatchObject({ code: kind, message: 'nope' });
  });

  it('ignores a message with nothing in it, and an event list that is empty', async () => {
    const batches = vi.fn();
    const watcher = {
      watch: (_path: string, _body: unknown, onMessage: (message: unknown) => void) => {
        onMessage(null);
        onMessage({});
        onMessage({ result: {} });
        onMessage({ result: { events: [] } });
        return Promise.resolve();
      },
    };
    await watchKeys(watcher, bytes('/a'), {}, batches, new AbortController().signal);
    expect(batches).not.toHaveBeenCalled();
  });

  it('passes a failure of the stream on', async () => {
    const watcher = {
      watch: () => Promise.reject(new DbError('connection-failed', 'link lost')),
    };
    await expect(
      watchKeys(watcher, bytes('/a'), {}, () => undefined, new AbortController().signal),
    ).rejects.toThrow('link lost');
  });
});
