// "Duplicate Table…" (V10.2.3) on SQL Server: an identity column, an index and a key to
// itself; the checks are in helpers/duplicate-suite.ts.

import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { testDatabase } from '../../helpers/databases';
import { duplicateSuite } from '../../helpers/duplicate-suite';

duplicateSuite({
  label: 'mssql',
  driver: () => mssqlDriver,
  config: () => {
    const db = testDatabase('mssql');
    return {
      id: 'dup-mssql',
      name: 'mssql',
      driver: 'mssql',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
    };
  },
  scope: { schema: 'dbo' },
  create: [
    `CREATE TABLE dbo.staff (
       id int IDENTITY(1, 1) PRIMARY KEY,
       name nvarchar(50) NOT NULL,
       boss int NULL,
       CONSTRAINT staff_boss_fk FOREIGN KEY (boss) REFERENCES dbo.staff (id))`,
    'CREATE INDEX staff_name_idx ON dbo.staff (name)',
    "INSERT INTO dbo.staff (name, boss) VALUES ('Ann', NULL), ('Bob', 1), ('Cy', 1)",
  ],
  drop: (table) => [`DROP TABLE IF EXISTS dbo.${table}`],
  name: (table) => `dbo.${table}`,
  reported: (table) => table,
  keys: true,
});
