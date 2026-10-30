// The server monitor (V8.5) on SQL Server, as `sa`: seeing other sessions takes
// VIEW SERVER STATE, and KILL takes ALTER ANY CONNECTION.

import { driver } from '../../../src/drivers/mssql';
import { serverConfig } from '../../helpers/explain-suite';
import { monitorSuite } from '../../helpers/monitor-suite';

monitorSuite({
  label: 'mssql',
  driver: () => driver,
  config: () => ({ ...serverConfig('mssql', 'mssql'), user: 'sa', password: 'Datanest_Root1' }),
  server: 'mssql',
  sqlDriver: 'mssql',
  slow: (marker) => `WAITFOR DELAY '00:00:30'; SELECT '${marker}' AS marker`,
  settings: { session: 'textsize', server: 'max server memory (MB)' },
  summary: ['uptimeSeconds', 'connections', 'maxConnections'],
});
