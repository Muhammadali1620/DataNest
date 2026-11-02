// ZooKeeper driver (V13.24), over Node's own sockets and the server's binary protocol.
// Bundled separately (dist/drivers/zookeeper.js) and loaded on the first ZooKeeper
// connection. Not a SQL driver: see D81.

import type { ZookeeperDriver } from '../zookeeper-driver';
import { openZookeeperSession } from './session';

export const driver: ZookeeperDriver = {
  id: 'zookeeper',
  openSession: openZookeeperSession,
};
