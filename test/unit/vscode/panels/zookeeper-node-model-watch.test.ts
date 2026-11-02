import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import {
  MAX_WATCH_EVENTS,
  ZookeeperNodeModel,
} from '../../../../src/vscode/panels/zookeeper-node-model';
import { FakeZookeeperSession, MemoryTree } from '../../../helpers/fake-zookeeper-driver';

let tree: MemoryTree;
let session: FakeZookeeperSession;

function model(
  path: string,
  options: { readOnly?: boolean; flushMs?: number; watchable?: boolean } = {},
): ZookeeperNodeModel {
  return new ZookeeperNodeModel({
    path,
    connectionName: 'Ensemble',
    readOnly: options.readOnly ?? false,
    session: () =>
      Promise.resolve(
        options.watchable === false
          ? {
              children: session.children.bind(session),
              getData: session.getData.bind(session),
              exists: session.exists.bind(session),
              getAcl: session.getAcl.bind(session),
              setAcl: session.setAcl.bind(session),
              create: session.create.bind(session),
              setData: session.setData.bind(session),
              remove: session.remove.bind(session),
            }
          : session,
      ),
    watchFlushMs: options.flushMs ?? 5,
  });
}

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

beforeEach(() => {
  tree = new MemoryTree();
  session = new FakeZookeeperSession(tree);
  tree.put('/app', 'hello');
  tree.put('/app/a');
});

describe('watching a znode', () => {
  it('is not watching until it is asked to', async () => {
    const state = await model('/app').refresh();
    expect(state.watching).toBeUndefined();
    expect(state.events).toBeUndefined();
    expect(state.watchNotice).toBeUndefined();
  });

  it('starts, reads the znode once the watch is set, and says it is watching', async () => {
    const watched = model('/app');
    const started = await watched.startWatch(vi.fn());
    expect(started).toMatchObject({ watching: true, exists: true, value: { text: 'hello' } });
    expect(watched.watching).toBe(true);
    expect(tree.watchers.size).toBe(1);
    watched.stopWatch();
  });

  it('lists a change of the data and shows the new data', async () => {
    const watched = model('/app');
    const changed = vi.fn();
    await watched.startWatch(changed);
    await session.setData('/app', encode('there'), -1);
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    expect(changed).toHaveBeenCalledTimes(1);
    const state = watched.state();
    expect(state.value).toEqual({ text: 'there' });
    expect(state.version).toBe(1);
    expect(state.events?.[0]).toMatchObject({ kind: 'data', version: 1, size: 5, children: 1 });
    watched.stopWatch();
  });

  it('lists a change of the children and shows the new list', async () => {
    const watched = model('/app');
    await watched.startWatch(vi.fn());
    await session.create('/app/b', encode(''), 'persistent');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    expect(watched.state().events?.[0]).toMatchObject({ kind: 'children', children: 2 });
    expect(watched.state().children).toEqual(['a', 'b']);
    watched.stopWatch();
  });

  it('lists the deletion once, and shows the znode as gone', async () => {
    tree.put('/gone');
    const watched = model('/gone');
    await watched.startWatch(vi.fn());
    await session.remove('/gone', -1);
    await vi.waitFor(() => {
      expect(watched.state().exists).toBe(false);
    });
    expect(watched.state().events?.map((event) => event.kind)).toEqual(['deleted']);
    expect(watched.state().events?.[0]).toMatchObject({ version: 0, size: 0, children: 0 });
    watched.stopWatch();
  });

  it('lists the creation of a znode that was not there', async () => {
    const watched = model('/later');
    const started = await watched.startWatch(vi.fn());
    expect(started.exists).toBe(false);
    await session.create('/later', encode('hi'), 'persistent');
    await vi.waitFor(() => {
      expect(watched.state().exists).toBe(true);
    });
    expect(watched.state().events?.map((event) => event.kind)).toEqual(['created']);
    watched.stopWatch();
  });

  it('gathers reports that come close together into one read and one call', async () => {
    const watched = model('/app');
    const changed = vi.fn();
    await watched.startWatch(changed);
    await session.setData('/app', encode('1'), -1);
    await session.setData('/app', encode('2'), -1);
    await session.create('/app/b', encode(''), 'persistent');
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(2);
    });
    // The two changes of the data are one line: the page shows how the znode looks now.
    expect(watched.state().events?.map((event) => event.kind)).toEqual(['data', 'children']);
    expect(changed).toHaveBeenCalledTimes(1);
    watched.stopWatch();
  });

  it('keeps the newest changes only', async () => {
    const watched = model('/app', { flushMs: 0 });
    await watched.startWatch(vi.fn());
    for (let index = 0; index < MAX_WATCH_EVENTS + 20; index += 1) {
      await session.setData('/app', encode(String(index)), -1);
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    await vi.waitFor(() => {
      expect(watched.state().value).toEqual({ text: String(MAX_WATCH_EVENTS + 19) });
    });
    watched.stopWatch();
    expect(watched.state().events?.length).toBeLessThanOrEqual(MAX_WATCH_EVENTS);
  });

  it('stops: nothing more is listed, what was seen stays, the watch is let go', async () => {
    const watched = model('/app');
    await watched.startWatch(vi.fn());
    await session.setData('/app', encode('x'), -1);
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    const stopped = watched.stopWatch();
    expect(stopped.watching).toBeUndefined();
    expect(stopped.events).toHaveLength(1);
    expect(watched.watching).toBe(false);
    expect(tree.watchers.size).toBe(0);
    await session.setData('/app', encode('y'), -1);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(watched.state().events).toHaveLength(1);
  });

  it('stopping a watch that never started is harmless', () => {
    expect(model('/app').stopWatch().watching).toBeUndefined();
  });

  it('starting again replaces the watch', async () => {
    const watched = model('/app');
    await watched.startWatch(vi.fn());
    await watched.startWatch(vi.fn());
    expect(tree.watchers.size).toBe(1);
    watched.stopWatch();
  });

  it('clears the list', async () => {
    const watched = model('/app');
    await watched.startWatch(vi.fn());
    await session.setData('/app', encode('x'), -1);
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    const cleared = watched.clearEvents();
    expect(cleared.events).toBeUndefined();
    expect(cleared.watching).toBe(true);
    watched.stopWatch();
  });

  it('says so when the session is lost, and keeps what was seen', async () => {
    const watched = model('/app');
    const changed = vi.fn();
    await watched.startWatch(changed);
    await session.setData('/app', encode('x'), -1);
    await vi.waitFor(() => {
      expect(watched.state().events).toHaveLength(1);
    });
    changed.mockClear();
    session.lose(new DbError('connection-failed', 'The connection to ZooKeeper was closed'));
    expect(changed).toHaveBeenCalledTimes(1);
    const state = watched.state();
    expect(state.watching).toBeUndefined();
    expect(state.watchNotice).toBe('Watching stopped: The connection to ZooKeeper was closed');
    expect(state.events).toHaveLength(1);
    expect(watched.watching).toBe(false);
  });

  it('says so when the znode cannot be read after a change', async () => {
    const watched = model('/app');
    const changed = vi.fn();
    await watched.startWatch(changed);
    const real = session.children.bind(session);
    session.children = () => Promise.reject(new DbError('busy', 'the server is busy'));
    await session.setData('/app', encode('x'), -1);
    await vi.waitFor(() => {
      expect(watched.state().watchNotice).toContain('the server is busy');
    });
    session.children = real;
    expect(watched.watching).toBe(false);
    expect(changed).toHaveBeenCalled();
  });

  it('fails to start when the watch cannot be set, and watches nothing', async () => {
    const watched = model('/app');
    session.watchFailure = new DbError('permission-denied', 'not allowed');
    await expect(watched.startWatch(vi.fn())).rejects.toThrow('not allowed');
    expect(watched.watching).toBe(false);
    expect(tree.watchers.size).toBe(0);
  });

  it('fails to start when the first read fails, and lets the watch go', async () => {
    const watched = model('/app');
    session.getData = () => Promise.reject(new DbError('timeout', 'too slow'));
    await expect(watched.startWatch(vi.fn())).rejects.toThrow('too slow');
    expect(watched.watching).toBe(false);
    expect(tree.watchers.size).toBe(0);
  });

  it('does not watch through a session that cannot', async () => {
    const watched = model('/app', { watchable: false });
    const error = await watched.startWatch(vi.fn()).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(DbError);
    expect((error as DbError).code).toBe('unsupported');
    expect(watched.watching).toBe(false);
  });

  it('lets go of the watch when it is stopped while the watch is being set', async () => {
    const watched = model('/app');
    const real = session.watchNode.bind(session);
    session.watchNode = async (...args) => {
      const stop = await real(...args);
      // The user stops it just as the watch is set.
      watched.stopWatch();
      return stop;
    };
    const state = await watched.startWatch(vi.fn());
    expect(state.watching).toBeUndefined();
    expect(tree.watchers.size).toBe(0);
    expect(watched.watching).toBe(false);
  });

  it('watches a read-only connection too: watching changes nothing', async () => {
    const watched = model('/app', { readOnly: true });
    expect((await watched.startWatch(vi.fn())).watching).toBe(true);
    watched.stopWatch();
  });
});
