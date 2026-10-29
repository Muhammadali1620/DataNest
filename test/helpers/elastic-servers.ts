// The Elasticsearch node of the `elasticsearch` group in docker/compose.yml (V7.8): plain
// HTTP on 7200 with security on.

export const TEST_ELASTIC = {
  host: '127.0.0.1',
  port: 7200,
  /** The superuser. */
  user: { name: 'elastic', password: 'datanest' },
  /** May read every index. */
  reader: { name: 'reader', password: 'reader' },
} as const;
