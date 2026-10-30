// EXPLAIN (V8.2) on SQL Server: the estimated XML showplan and the actual one.

import { driver } from '../../../src/drivers/mssql';
import { explainSuite, serverConfig } from '../../helpers/explain-suite';

explainSuite({
  label: 'mssql',
  driver: () => driver,
  config: () => serverConfig('mssql', 'mssql'),
  server: 'mssql',
  sqlDriver: 'mssql',
  change: "UPDATE customers SET full_name = full_name WHERE country = 'XX'",
});
