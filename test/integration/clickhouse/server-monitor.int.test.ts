// The server monitor (V8.5) on ClickHouse: running queries, settings of the session and
// the server, metrics and events.

import { driver } from '../../../src/drivers/clickhouse';
import { serverConfig } from '../../helpers/explain-suite';
import { monitorSuite } from '../../helpers/monitor-suite';

monitorSuite({
  label: 'clickhouse',
  driver: () => driver,
  config: () => serverConfig('clickhouse', 'clickhouse'),
  server: 'clickhouse',
  sqlDriver: 'clickhouse',
  // sleep() stops at 3 s per block, so one row per block makes 60 s of them.
  slow: (marker) => `SELECT sleep(3), '${marker}' FROM numbers(20) SETTINGS max_block_size = 1`,
  settings: { session: 'max_threads', server: 'max_connections' },
  summary: ['uptimeSeconds', 'connections'],
});
