// "Find Data…" (V10.2.6) on SQL Server: N'' literals and `[` escaped in LIKE; the
// checks are in helpers/data-search-suite.ts.

import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { testDatabase } from '../../helpers/databases';
import { dataSearchSuite, SEARCH_ROWS } from '../../helpers/data-search-suite';

const values = SEARCH_ROWS.map(
  ([note, title], index) =>
    `(${index + 1}, ${note === null ? 'NULL' : `N'${note.replaceAll("'", "''")}'`}, N'${title}', ${index * 7})`,
).join(', ');

dataSearchSuite({
  label: 'mssql',
  driver: () => mssqlDriver,
  config: () => {
    const db = testDatabase('mssql');
    return {
      id: 'find-mssql',
      name: 'mssql',
      driver: 'mssql',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
    };
  },
  id: 'mssql',
  scope: { schema: 'dbo' },
  create: [
    'CREATE TABLE dbo.find_me (id INT PRIMARY KEY, note NVARCHAR(MAX) NULL, title NVARCHAR(50) NOT NULL, n INT NOT NULL)',
    `INSERT INTO dbo.find_me VALUES ${values}`,
  ],
  drop: ['DROP TABLE IF EXISTS dbo.find_me'],
  name: 'dbo.find_me',
  reported: (name) => name,
});
