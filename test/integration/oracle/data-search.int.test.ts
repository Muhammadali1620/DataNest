// "Find Data…" (V10.2.6) on Oracle: a CLOB column searched through UPPER and LIKE, names
// in upper case; the checks are in helpers/data-search-suite.ts.

import { driver as oracleDriver } from '../../../src/drivers/oracle';
import { ORACLE_SERVICE, testDatabase } from '../../helpers/databases';
import { dataSearchSuite, SEARCH_ROWS } from '../../helpers/data-search-suite';

dataSearchSuite({
  label: 'oracle',
  driver: () => oracleDriver,
  config: () => {
    const db = testDatabase('oracle');
    return {
      id: 'find-oracle',
      name: 'oracle',
      driver: 'oracle',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: ORACLE_SERVICE,
    };
  },
  id: 'oracle',
  scope: { schema: 'DATANEST' },
  create: [
    'CREATE TABLE find_me (id NUMBER PRIMARY KEY, note CLOB, title VARCHAR2(50) NOT NULL, n NUMBER NOT NULL)',
    ...SEARCH_ROWS.map(
      ([note, title], index) =>
        `INSERT INTO find_me VALUES (${index + 1}, ${note === null ? 'NULL' : `'${note.replaceAll("'", "''")}'`}, '${title}', ${index * 7})`,
    ),
    'COMMIT',
  ],
  drop: ['DROP TABLE IF EXISTS find_me PURGE'],
  name: 'find_me',
  reported: (name) => name.toUpperCase(),
});
