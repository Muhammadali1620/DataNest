// The Redis servers of the `redis` group in docker/compose.yml (V7.1): one server with
// ACL users and TLS, a master behind a Sentinel, and a cluster of three masters. The
// Sentinel and the cluster listen on the same ports inside and outside, because they
// hand out their own addresses.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker', 'tls');

export const TEST_REDIS = {
  host: '127.0.0.1',
  /** Plain port of the standalone server; the default user's password is `datanest`. */
  port: 7379,
  /** The same server over TLS, with the test CA in docker/tls. */
  tlsPort: 7380,
  /** May do everything. */
  user: { name: 'datanest', password: 'datanest' },
  /** May only read. */
  reader: { name: 'reader', password: 'reader' },
  defaultPassword: 'datanest',
  sentinel: {
    port: 7382,
    masterPort: 7381,
    masterName: 'datanest',
    /** The Sentinel's own password; the master's is `datanest`. */
    password: 'sentinel',
    masterPassword: 'datanest',
  },
  cluster: { ports: [7391, 7392, 7393], password: 'datanest' },
  tls: {
    ca: join(TLS_DIR, 'ca.crt'),
    otherCa: join(TLS_DIR, 'other-ca.crt'),
    cert: join(TLS_DIR, 'client.crt'),
    key: join(TLS_DIR, 'client.key'),
  },
} as const;
