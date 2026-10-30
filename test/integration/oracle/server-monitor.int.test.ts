// The server monitor (V8.5) on Oracle. ALTER SYSTEM takes a DBA, so the suite runs as
// SYSTEM.

import { driver } from '../../../src/drivers/oracle';
import { serverConfig } from '../../helpers/explain-suite';
import { monitorSuite } from '../../helpers/monitor-suite';

monitorSuite({
  label: 'oracle',
  driver: () => driver,
  config: () => ({
    ...serverConfig('oracle', 'oracle'),
    user: 'system',
    password: 'datanest_root',
  }),
  server: 'oracle',
  sqlDriver: 'oracle',
  slow: (marker) =>
    `DECLARE marker VARCHAR2(40) := '${marker}'; BEGIN DBMS_SESSION.SLEEP(30); END;`,
  settings: { session: 'nls_date_format', server: 'processes' },
  summary: ['uptimeSeconds', 'connections', 'maxConnections'],
});
