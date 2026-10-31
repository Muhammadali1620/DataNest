// "Find Data…" (V10.2.6) on ClickHouse: a plain case-insensitive search without LIKE; the
// checks are in helpers/data-search-suite.ts.

import { driver as clickhouseDriver } from '../../../src/drivers/clickhouse';
import { testDatabase } from '../../helpers/databases';
import { dataSearchSuite, SEARCH_ROWS } from '../../helpers/data-search-suite';

const values = SEARCH_ROWS.map(
  ([note, title], index) =>
    `(${index + 1}, ${note === null ? 'NULL' : `'${note.replaceAll("'", "\\'")}'`}, '${title}', ${index * 7})`,
).join(', ');

dataSearchSuite({
  label: 'clickhouse',
  driver: () => clickhouseDriver,
  config: () => {
    const db = testDatabase('clickhouse');
    return {
      id: 'find-clickhouse',
      name: 'clickhouse',
      driver: 'clickhouse',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
    };
  },
  id: 'clickhouse',
  scope: { database: 'datanest_test' },
  create: [
    'CREATE TABLE datanest_test.find_me (id UInt32, note Nullable(String), title String, n Int32) ENGINE = MergeTree ORDER BY id',
    `INSERT INTO datanest_test.find_me VALUES ${values}`,
  ],
  drop: ['DROP TABLE IF EXISTS datanest_test.find_me'],
  name: 'datanest_test.find_me',
  reported: (name) => name,
});
