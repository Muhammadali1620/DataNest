// "Duplicate Table…" (V10.2.3) on ClickHouse: a MergeTree table without keys or
// numbering, copied by the server; the checks are in helpers/duplicate-suite.ts.

import { driver as clickhouseDriver } from '../../../src/drivers/clickhouse';
import { testDatabase } from '../../helpers/databases';
import { duplicateSuite } from '../../helpers/duplicate-suite';

duplicateSuite({
  label: 'clickhouse',
  driver: () => clickhouseDriver,
  config: () => {
    const db = testDatabase('clickhouse');
    return {
      id: 'dup-clickhouse',
      name: 'clickhouse',
      driver: 'clickhouse',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
    };
  },
  scope: { database: 'datanest_test' },
  create: [
    `CREATE TABLE datanest_test.staff (id UInt32, name String, boss Nullable(UInt32))
     ENGINE = MergeTree ORDER BY id`,
    "INSERT INTO datanest_test.staff VALUES (1, 'Ann', NULL), (2, 'Bob', 1), (3, 'Cy', 1)",
  ],
  drop: (table) => [`DROP TABLE IF EXISTS datanest_test.${table}`],
  name: (table) => `datanest_test.${table}`,
  reported: (table) => table,
  keys: false,
});
