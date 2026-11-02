import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const TLS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'docker', 'tls');

/** The Grafana Loki server of the `loki` group (V13.25): the HTTP port, no tenant, no sign-in. */
export const TEST_LOKI = {
  host: '127.0.0.1',
  port: 7100,
  /** The same server over HTTPS (V13.32), with the test certificate of docker/tls. */
  tlsPort: 7101,
  ca: join(TLS_DIR, 'ca.crt'),
  otherCa: join(TLS_DIR, 'other-ca.crt'),
} as const;
