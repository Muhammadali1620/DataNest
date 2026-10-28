// Tables built by the designer on the real servers: the SQL a design turns into
// must run, and the table it creates must be the one that was designed.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import {
  type ColumnDesign,
  designProblems,
  type TableDesign,
} from '../../../src/shared/table-design';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

function serverConfig(id: TestDatabaseId, driver: DriverId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `design-${id}`,
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

function col(name: string, overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  return {
    id: name,
    name,
    type: 'text',
    length: '',
    nullable: true,
    defaultValue: '',
    autoIncrement: false,
    primaryKey: false,
    comment: '',
    ...overrides,
  };
}

async function create(
  session: Session,
  driver: Driver,
  design: TableDesign,
  scope: { database?: string; schema?: string } = {},
): Promise<void> {
  expect(designProblems(design, driver.id)).toEqual([]);
  for (const statement of driver.dialect.ddl.createTable({ ...scope, name: design.name }, design)) {
    await runAll(session, statement);
  }
}

describe.each(['mysql', 'mariadb'] as const)('designed tables on %s', (serverId) => {
  let session: Session;
  const database = testDatabase(serverId).database;

  beforeAll(async () => {
    session = await mysqlDriver.openSession(serverConfig(serverId, 'mysql'));
    await runAll(session, 'DROP TABLE IF EXISTS design_probe');
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS design_probe');
    await session.close();
  });

  it('creates every kind of column the designer offers', async () => {
    await create(
      session,
      mysqlDriver,
      {
        name: 'design_probe',
        comment: "probe's table",
        columns: [
          col('id', {
            type: 'bigint unsigned',
            nullable: false,
            autoIncrement: true,
            primaryKey: true,
          }),
          col('code', { type: 'varchar', length: '20', nullable: false, comment: 'a; b' }),
          col('price', { type: 'decimal', length: '10,2', defaultValue: '0.00' }),
          col('state', { type: 'enum', length: "'new','done'", defaultValue: "'new'" }),
          col('made', { type: 'datetime', defaultValue: 'CURRENT_TIMESTAMP' }),
        ],
      },
      { database },
    );
    const columns = await session.metadata.listColumns({ database, name: 'design_probe' });
    // MariaDB still prints the display width of integers: bigint(20).
    const type = (dataType: string) => dataType.replace(/^(\w*int)\(\d+\)/, '$1');
    expect(columns.map((c) => [c.name, type(c.dataType), c.nullable, c.primaryKey])).toEqual([
      ['id', 'bigint unsigned', false, true],
      ['code', 'varchar(20)', false, false],
      ['price', 'decimal(10,2)', true, false],
      ['state', "enum('new','done')", true, false],
      ['made', 'datetime', true, false],
    ]);
    await runAll(session, "INSERT INTO design_probe (code) VALUES ('x'), ('y')");
    const rows = await runAll(session, 'SELECT id, price, state FROM design_probe ORDER BY id');
    expect(rows.rows).toEqual([
      [1, { kind: 'decimal', text: '0.00' }, 'new'],
      [2, { kind: 'decimal', text: '0.00' }, 'new'],
    ]);
    const [ddl] = await session.metadata.getDefinition({
      database,
      kind: 'table',
      name: 'design_probe',
    });
    expect(ddl).toContain("COMMENT 'a; b'");
    expect(ddl).toContain("COMMENT='probe''s table'");
  });

  it('reports the server error for a design only the server can judge', async () => {
    await expect(
      create(
        session,
        mysqlDriver,
        { name: 'design_bad', comment: '', columns: [col('a', { type: 'no_such_type' })] },
        { database },
      ),
    ).rejects.toMatchObject({ code: 'syntax' });
  });
});

describe('designed tables on postgres', () => {
  let session: Session;

  beforeAll(async () => {
    session = await postgresDriver.openSession(serverConfig('postgres', 'postgres'));
    await runAll(session, 'DROP TABLE IF EXISTS inventory.design_probe, design_pair');
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS inventory.design_probe, design_pair');
    await session.close();
  });

  it('creates identity, timestamps, arrays and comments in another schema', async () => {
    await create(
      session,
      postgresDriver,
      {
        name: 'design_probe',
        comment: 'probe',
        columns: [
          col('id', { type: 'bigint', nullable: false, autoIncrement: true, primaryKey: true }),
          col('label', { type: 'varchar', length: '40', nullable: false, comment: "it's" }),
          col('at', { type: 'timestamp with time zone', length: '3', defaultValue: 'now()' }),
          col('tags', { type: 'text[]', defaultValue: "'{}'" }),
        ],
      },
      { schema: 'inventory' },
    );
    const columns = await session.metadata.listColumns({
      schema: 'inventory',
      name: 'design_probe',
    });
    expect(columns.map((c) => [c.name, c.dataType, c.nullable, c.primaryKey])).toEqual([
      ['id', 'bigint', false, true],
      ['label', 'character varying(40)', false, false],
      ['at', 'timestamp(3) with time zone', true, false],
      ['tags', 'text[]', true, false],
    ]);
    await runAll(session, "INSERT INTO inventory.design_probe (label) VALUES ('a')");
    // A bigint that fits a double arrives as a number (D24).
    expect((await runAll(session, 'SELECT id FROM inventory.design_probe')).rows).toEqual([[1]]);
    const statements = await session.metadata.getDefinition({
      schema: 'inventory',
      kind: 'table',
      name: 'design_probe',
    });
    expect(statements).toContain(`COMMENT ON TABLE "inventory"."design_probe" IS 'probe'`);
    expect(statements).toContain(`COMMENT ON COLUMN "inventory"."design_probe"."label" IS 'it''s'`);
  });

  it('creates a composite key', async () => {
    await create(session, postgresDriver, {
      name: 'design_pair',
      comment: '',
      columns: [
        col('a', { type: 'integer', primaryKey: true }),
        col('b', { type: 'integer', primaryKey: true }),
      ],
    });
    const indexes = await session.metadata.listIndexes({ name: 'design_pair' });
    expect(indexes[0]).toMatchObject({ primary: true, columns: ['a', 'b'] });
  });
});

describe('designed tables on sqlite', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let dir: string;
  let session: Session;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-design-'));
    session = await driver.openSession({
      id: 'design-sqlite',
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'design.db'),
    });
  }, 60_000);

  afterAll(async () => {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  it('creates an AUTOINCREMENT key and defaults', async () => {
    await create(session, driver, {
      name: 'notes',
      comment: '',
      columns: [
        col('id', { type: 'integer', nullable: false, autoIncrement: true, primaryKey: true }),
        col('body', { nullable: false, defaultValue: "''" }),
        col('created', { defaultValue: 'CURRENT_TIMESTAMP' }),
      ],
    });
    await runAll(session, 'INSERT INTO notes DEFAULT VALUES');
    await runAll(session, 'INSERT INTO notes DEFAULT VALUES');
    expect((await runAll(session, 'SELECT id, body FROM notes ORDER BY id')).rows).toEqual([
      [1, ''],
      [2, ''],
    ]);
    const [ddl] = await session.metadata.getDefinition({ kind: 'table', name: 'notes' });
    expect(ddl).toContain('PRIMARY KEY AUTOINCREMENT');
  });

  it('creates a composite key at the end', async () => {
    await create(session, driver, {
      name: 'pairs',
      comment: '',
      columns: [
        col('a', { type: 'integer', primaryKey: true }),
        col('b', { type: 'text', primaryKey: true }),
      ],
    });
    const columns = await session.metadata.listColumns({ name: 'pairs' });
    expect(columns.map((c) => c.primaryKey)).toEqual([true, true]);
  });
});
