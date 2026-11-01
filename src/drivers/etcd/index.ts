// etcd driver (V13.19), over Node's own HTTP client and the cluster's JSON gateway.
// Bundled separately (dist/drivers/etcd.js) and loaded on the first etcd connection. Not
// a SQL driver: see D81.

import type { EtcdDriver } from '../etcd-driver';
import { openEtcdSession } from './session';

export const driver: EtcdDriver = {
  id: 'etcd',
  openSession: openEtcdSession,
};
