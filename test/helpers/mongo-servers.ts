// The MongoDB server of the `mongodb` group in docker/compose.yml (V7.5): a single-member
// replica set on 7017 that takes TLS and plain connections on the same port. It listens
// on that port inside and outside, because the set hands out its members' addresses.

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker', 'tls');

export const TEST_MONGO = {
  host: '127.0.0.1',
  port: 7017,
  replicaSet: 'rs0',
  /** May do everything (root). */
  user: { name: 'datanest', password: 'datanest' },
  /** May only read, in every database. */
  reader: { name: 'reader', password: 'reader' },
  /** The subject of docker/tls/client.crt, a user in `$external` that may read. */
  certificateUser: 'CN=datanest_cert',
  tls: {
    ca: join(TLS_DIR, 'ca.crt'),
    otherCa: join(TLS_DIR, 'other-ca.crt'),
    cert: join(TLS_DIR, 'client.crt'),
    key: join(TLS_DIR, 'client.key'),
  },
} as const;
