// A ZooKeeper session to a server in this process, for the tests of the layers above the driver
// (V13.24): the real client talks to the in-memory server over a socket.

import { openZookeeperSession } from '../../src/drivers/zookeeper/session';
import type { ZookeeperSession } from '../../src/drivers/zookeeper-driver';
import type { ResolvedConnectionConfig } from '../../src/shared/connection';
import { FakeZookeeper } from './fake-zookeeper';

export interface FakeEnsemble {
  readonly server: FakeZookeeper;
  readonly session: ZookeeperSession;
  readonly port: number;
  /** Opens another session to the same server. */
  open(overrides?: Partial<ResolvedConnectionConfig>): Promise<ZookeeperSession>;
  close(): Promise<void>;
}

export async function fakeEnsemble(
  options: ConstructorParameters<typeof FakeZookeeper>[0] = {},
): Promise<FakeEnsemble> {
  const server = new FakeZookeeper(options);
  const port = await server.start();
  const opened: ZookeeperSession[] = [];
  const open = async (
    overrides: Partial<ResolvedConnectionConfig> = {},
  ): Promise<ZookeeperSession> => {
    const session = await openZookeeperSession({
      id: 'z',
      name: 'z',
      driver: 'zookeeper',
      host: '127.0.0.1',
      port,
      ...overrides,
    });
    opened.push(session);
    return session;
  };
  const session = await open();
  return {
    server,
    session,
    port,
    open,
    close: async () => {
      for (const one of opened) {
        await one.close().catch(() => undefined);
      }
      await server.stop();
    },
  };
}
