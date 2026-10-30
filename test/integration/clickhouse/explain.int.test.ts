// EXPLAIN (V8.2) on ClickHouse: the query plan with index use, no costs.

import { driver } from '../../../src/drivers/clickhouse';
import { explainSuite, serverConfig } from '../../helpers/explain-suite';

explainSuite({
  label: 'clickhouse',
  driver: () => driver,
  config: () => serverConfig('clickhouse', 'clickhouse'),
  server: 'clickhouse',
  sqlDriver: 'clickhouse',
});
