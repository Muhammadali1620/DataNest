// The ZooKeeper client's watches against a server in this process that speaks the same
// protocol and fires one-shot watches as the real one does: each kind of change, setting the
// watch again after every report, a znode that is not there yet, the chroot, and the end of
// the session. The real server is the reference (the `zookeeper` integration group).

import type { Socket } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import type {
  ZookeeperSession,
  ZookeeperWatchEvent,
} from '../../../../src/drivers/zookeeper-driver';
import { openZookeeperSession } from '../../../../src/drivers/zookeeper/session';
import type { ResolvedConnectionConfig } from '../../../../src/shared/connection';
import { FakeZookeeper } from '../../../helpers/fake-zookeeper';

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);

const cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0)) {
    await step();
  }
});

async function setup(database?: string): Promise<{
  server: FakeZookeeper;
  watcher: ZookeeperSession;
  writer: ZookeeperSession;
}> {
  const server = new FakeZookeeper();
  if (database !== undefined) {
    server.seed(database);
  }
  const port = await server.start();
  cleanup.push(() => server.stop());
  const config = (id: string): ResolvedConnectionConfig => ({
    id,
    name: id,
    driver: 'zookeeper',
    host: '127.0.0.1',
    port,
    ...(database === undefined ? {} : { database }),
  });
  const watcher = await openZookeeperSession(config('w'));
  const writer = await openZookeeperSession(config('r'));
  cleanup.push(() => watcher.close());
  cleanup.push(() => writer.close());
  return { server, watcher, writer };
}

/** Collects what a watch reports. */
function listen(): {
  events: ZookeeperWatchEvent[];
  onEvent: (event: ZookeeperWatchEvent) => void;
  lost: ReturnType<typeof vi.fn<(error: Error) => void>>;
} {
  const events: ZookeeperWatchEvent[] = [];
  return {
    events,
    onEvent: (event) => events.push(event),
    lost: vi.fn<(error: Error) => void>(),
  };
}

describe('watching a znode', () => {
  it('reports a change of the data', async () => {
    const { server, watcher, writer } = await setup();
    server.seed('/a', 'one');
    const heard = listen();
    await watcher.watchNode('/a', heard.onEvent, heard.lost);
    await writer.setData('/a', encode('two'), -1);
    await vi.waitFor(() => {
      expect(heard.events).toEqual([{ kind: 'data', path: '/a' }]);
    });
  });

  it('sets the watch again by itself: the second change is reported too', async () => {
    const { server, watcher, writer } = await setup();
    server.seed('/a', 'one');
    const heard = listen();
    await watcher.watchNode('/a', heard.onEvent, heard.lost);
    await writer.setData('/a', encode('two'), -1);
    await vi.waitFor(() => {
      expect(heard.events).toHaveLength(1);
    });
    await writer.setData('/a', encode('three'), -1);
    await writer.setData('/a', encode('four'), -1);
    await vi.waitFor(() => {
      expect(heard.events.length).toBeGreaterThanOrEqual(2);
    });
    expect(heard.events.every((event) => event.kind === 'data')).toBe(true);
  });

  it('reports a child that is added and one that is removed', async () => {
    const { server, watcher, writer } = await setup();
    server.seed('/a');
    const heard = listen();
    await watcher.watchNode('/a', heard.onEvent, heard.lost);
    await writer.create('/a/x', encode(''), 'persistent');
    await vi.waitFor(() => {
      expect(heard.events).toEqual([{ kind: 'children', path: '/a' }]);
    });
    await writer.remove('/a/x', -1);
    await vi.waitFor(() => {
      expect(heard.events).toHaveLength(2);
    });
    expect(heard.events[1]).toEqual({ kind: 'children', path: '/a' });
  });

  it('reports the deletion of the znode', async () => {
    const { server, watcher, writer } = await setup();
    server.seed('/a');
    const heard = listen();
    await watcher.watchNode('/a', heard.onEvent, heard.lost);
    await writer.remove('/a', -1);
    await vi.waitFor(() => {
      expect(heard.events.map((event) => event.kind)).toContain('deleted');
    });
    expect(heard.events.every((event) => event.path === '/a')).toBe(true);
  });

  it('watches a znode that is not there yet, and reports when it is made', async () => {
    const { watcher, writer } = await setup();
    const heard = listen();
    await watcher.watchNode('/later', heard.onEvent, heard.lost);
    await writer.create('/later', encode('hi'), 'persistent');
    await vi.waitFor(() => {
      expect(heard.events).toEqual([{ kind: 'created', path: '/later' }]);
    });
    // Once there, its own changes are watched as well.
    await writer.setData('/later', encode('hello'), -1);
    await vi.waitFor(() => {
      expect(heard.events.map((event) => event.kind)).toContain('data');
    });
  });

  it('does not report changes of other znodes', async () => {
    const { server, watcher, writer } = await setup();
    server.seed('/a');
    server.seed('/b');
    const heard = listen();
    await watcher.watchNode('/a', heard.onEvent, heard.lost);
    await writer.setData('/b', encode('x'), -1);
    await writer.create('/b/c', encode(''), 'persistent');
    await writer.setData('/a', encode('x'), -1);
    await vi.waitFor(() => {
      expect(heard.events).toHaveLength(1);
    });
    expect(heard.events[0]).toEqual({ kind: 'data', path: '/a' });
  });

  it('reports to every watcher of the same znode', async () => {
    const { server, watcher, writer } = await setup();
    server.seed('/a');
    const first = listen();
    const second = listen();
    await watcher.watchNode('/a', first.onEvent, first.lost);
    await watcher.watchNode('/a', second.onEvent, second.lost);
    await writer.setData('/a', encode('x'), -1);
    await vi.waitFor(() => {
      expect(first.events).toHaveLength(1);
      expect(second.events).toHaveLength(1);
    });
  });

  it('speaks of paths below the chroot, without it', async () => {
    const { server, watcher, writer } = await setup('/app');
    server.seed('/app/node', 'one');
    const heard = listen();
    await watcher.watchNode('/node', heard.onEvent, heard.lost);
    await writer.setData('/node', encode('two'), -1);
    await vi.waitFor(() => {
      expect(heard.events).toEqual([{ kind: 'data', path: '/node' }]);
    });
    await watcher.watchNode('/', heard.onEvent, heard.lost);
    await writer.create('/other', encode(''), 'persistent');
    await vi.waitFor(() => {
      expect(heard.events).toContainEqual({ kind: 'children', path: '/' });
    });
  });

  it('stops reporting once the watch is let go', async () => {
    const { server, watcher, writer } = await setup();
    server.seed('/a');
    const heard = listen();
    const stop = await watcher.watchNode('/a', heard.onEvent, heard.lost);
    stop();
    await writer.setData('/a', encode('x'), -1);
    await vi.waitFor(() => {
      expect(server.notifications).toContain('3:/a');
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heard.events).toEqual([]);
  });

  it('tells its watchers once when the link is lost, and then forgets them', async () => {
    const { server, watcher } = await setup();
    server.seed('/a');
    const heard = listen();
    await watcher.watchNode('/a', heard.onEvent, heard.lost);
    server.dropAll();
    await vi.waitFor(() => {
      expect(heard.lost).toHaveBeenCalledTimes(1);
    });
    expect(heard.lost.mock.calls[0]?.[0]).toBeInstanceOf(DbError);
  });

  it('does not tell watchers of a session the user closed', async () => {
    const { server, watcher } = await setup();
    server.seed('/a');
    const heard = listen();
    await watcher.watchNode('/a', heard.onEvent, heard.lost);
    await watcher.close();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard.lost).not.toHaveBeenCalled();
  });

  it('fails to watch on a session that is gone', async () => {
    const { watcher } = await setup();
    await watcher.close();
    await expect(
      watcher.watchNode(
        '/a',
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow();
  });

  it('fails to watch a znode the user may not read', async () => {
    const { server, watcher } = await setup();
    server.seed('/locked', '', {
      acl: [{ perms: 0, scheme: 'digest', id: 'nobody:x' }],
    });
    await expect(
      watcher.watchNode(
        '/locked',
        () => undefined,
        () => undefined,
      ),
    ).rejects.toThrow();
  });

  it('ignores a notification of a kind it does not know', async () => {
    const { server, watcher } = await setup();
    server.seed('/a');
    const heard = listen();
    await watcher.watchNode('/a', heard.onEvent, heard.lost);
    // Type 5 (a child watch removed) and -1 (a change of the session) say nothing to report.
    // They are sent like the others, from the server's side of the socket.
    const sockets = (server as unknown as { sockets: Set<Socket> }).sockets;
    for (const socket of sockets) {
      for (const type of [5, -1]) {
        const body = Buffer.concat([
          Buffer.from([0xff, 0xff, 0xff, 0xff]),
          Buffer.alloc(8),
          Buffer.alloc(4),
          intBytes(type),
          intBytes(3),
          intBytes(2),
          Buffer.from('/a'),
        ]);
        socket.write(Buffer.concat([intBytes(body.length), body]));
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(heard.events).toEqual([]);
    expect(heard.lost).not.toHaveBeenCalled();
  });
});

function intBytes(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}
