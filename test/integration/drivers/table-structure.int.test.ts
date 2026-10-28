// The structure of existing tables as the designer reads it from the real servers:
// defaults as expressions that can be written back, auto numbering, comments,
// computed columns, referential actions and what a SQLite rebuild must recreate.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

function serverConfig(id: TestDatabaseId, driver: DriverId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `structure-${id}`,
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

describe.each(['mysql', 'mariadb'] as const)('table structure on %s', (serverId) => {
  let session: Session;
  const database = testDatabase(serverId).database;

  beforeAll(async () => {
    session = await mysqlDriver.openSession(serverConfig(serverId, 'mysql'));
    await runAll(session, 'DROP TABLE IF EXISTS structure_probe');
    await runAll(
      session,
      `CREATE TABLE structure_probe (
         id INT AUTO_INCREMENT PRIMARY KEY,
         customer_id INT NOT NULL COMMENT 'buyer',
         label VARCHAR(40) NOT NULL DEFAULT 'it''s',
         amount DECIMAL(10,2) DEFAULT 0.00,
         state ENUM('a','b') DEFAULT 'a',
         flags BIT(3) DEFAULT b'101',
         made DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         nothing VARCHAR(10) DEFAULT NULL,
         doubled DECIMAL(12,2) AS (amount * 2) VIRTUAL,
         KEY ix_label (label),
         FULLTEXT KEY ft_label (label),
         CONSTRAINT fk_structure_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
           ON DELETE CASCADE ON UPDATE RESTRICT
       ) COMMENT = 'probe table'`,
    );
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS structure_probe');
    await session.close();
  });

  it('reads columns with defaults as expressions that can be written back', async () => {
    const structure = await session.metadata.describeTable({ database, name: 'structure_probe' });
    const byName = new Map(structure.columns.map((column) => [column.name, column]));
    expect(byName.get('id')).toMatchObject({
      autoIncrement: true,
      nullable: false,
      generated: false,
    });
    expect(byName.get('customer_id')).toMatchObject({ comment: 'buyer', nullable: false });
    expect(byName.get('label')?.defaultExpression).toBe("'it''s'");
    expect(byName.get('amount')?.defaultExpression).toBe('0.00');
    expect(byName.get('state')?.defaultExpression).toBe("'a'");
    expect(byName.get('flags')?.defaultExpression).toBe("b'101'");
    expect(byName.get('made')?.defaultExpression?.toLowerCase()).toMatch(
      /^current_timestamp(\(\))? on update current_timestamp(\(\))?$/,
    );
    expect(byName.get('nothing')?.defaultExpression).toBeUndefined();
    expect(byName.get('doubled')).toMatchObject({ generated: true });
    expect(structure.comment).toBe('probe table');
    expect(structure.primaryKey).toEqual(['id']);
  });

  it('reads indexes with their methods and keys with their actions', async () => {
    const structure = await session.metadata.describeTable({ database, name: 'structure_probe' });
    expect(structure.indexes.map((index) => [index.name, index.method])).toEqual(
      expect.arrayContaining([
        ['ix_label', 'BTREE'],
        ['ft_label', 'FULLTEXT'],
      ]),
    );
    expect(structure.foreignKeys).toEqual([
      expect.objectContaining({
        name: 'fk_structure_customer',
        onDelete: 'CASCADE',
        onUpdate: 'RESTRICT',
      }),
    ]);
  });

  it('says not-found for a missing table', async () => {
    await expect(
      session.metadata.describeTable({ database, name: 'no_such_table' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});

describe('table structure on postgres', () => {
  let session: Session;

  beforeAll(async () => {
    session = await postgresDriver.openSession(serverConfig('postgres', 'postgres'));
    await runAll(session, 'DROP TABLE IF EXISTS structure_probe');
    await runAll(
      session,
      `CREATE TABLE structure_probe (
         id integer GENERATED ALWAYS AS IDENTITY,
         serial_id serial,
         label text NOT NULL DEFAULT 'it''s',
         price numeric(10,2),
         doubled numeric GENERATED ALWAYS AS (price * 2) STORED,
         status order_status DEFAULT 'new',
         code text,
         CONSTRAINT structure_probe_key PRIMARY KEY (id),
         CONSTRAINT structure_probe_code UNIQUE (code),
         CONSTRAINT structure_probe_customer FOREIGN KEY (serial_id) REFERENCES customers (id)
           ON DELETE SET NULL
       )`,
    );
    await runAll(session, "COMMENT ON TABLE structure_probe IS 'probe'");
    await runAll(session, "COMMENT ON COLUMN structure_probe.label IS 'name'");
    await runAll(session, 'CREATE INDEX structure_probe_label ON structure_probe (label)');
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS structure_probe');
    await session.close();
  });

  it('reads identity, serial, generated columns, defaults and comments', async () => {
    const structure = await session.metadata.describeTable({ name: 'structure_probe' });
    const byName = new Map(structure.columns.map((column) => [column.name, column]));
    expect(byName.get('id')).toMatchObject({ autoIncrement: true, nullable: false });
    expect(byName.get('id')?.defaultExpression).toBeUndefined();
    expect(byName.get('serial_id')).toMatchObject({
      autoIncrement: false,
      defaultExpression: "nextval('structure_probe_serial_id_seq'::regclass)",
    });
    expect(byName.get('label')).toMatchObject({
      defaultExpression: "'it''s'::text",
      comment: 'name',
      nullable: false,
    });
    expect(byName.get('doubled')).toMatchObject({ generated: true });
    expect(byName.get('doubled')?.defaultExpression).toBeUndefined();
    expect(byName.get('status')?.defaultExpression).toBe("'new'::order_status");
    expect(structure).toMatchObject({
      comment: 'probe',
      primaryKey: ['id'],
      primaryKeyName: 'structure_probe_key',
    });
  });

  it('tells indexes behind constraints from plain ones and reads key actions', async () => {
    const structure = await session.metadata.describeTable({ name: 'structure_probe' });
    const byName = new Map(structure.indexes.map((index) => [index.name, index]));
    expect(byName.get('structure_probe_code')).toMatchObject({ unique: true, constraint: true });
    expect(byName.get('structure_probe_label')?.constraint).toBeUndefined();
    expect(structure.foreignKeys).toEqual([
      expect.objectContaining({ onDelete: 'SET NULL', onUpdate: 'NO ACTION' }),
    ]);
  });

  it('says not-found for a missing table or a view', async () => {
    await expect(session.metadata.describeTable({ name: 'nope' })).rejects.toMatchObject({
      code: 'not-found',
    });
    await expect(session.metadata.describeTable({ name: 'order_totals' })).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});

describe('table structure on sqlite', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let dir: string;
  let session: Session;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-structure-'));
    session = await driver.openSession({
      id: 'structure-sqlite',
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'structure.db'),
    });
    for (const sql of [
      'CREATE TABLE parent (id INTEGER PRIMARY KEY)',
      `CREATE TABLE child (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         parent_id INTEGER REFERENCES parent (id) ON DELETE CASCADE,
         label TEXT NOT NULL DEFAULT 'x',
         made TEXT DEFAULT CURRENT_TIMESTAMP,
         twice INTEGER GENERATED ALWAYS AS (parent_id * 2) VIRTUAL
       )`,
      'CREATE INDEX ix_child_label ON child (label)',
      'CREATE INDEX ix_child_lower ON child (lower(label))',
      'CREATE TRIGGER child_touch AFTER INSERT ON child BEGIN SELECT 1; END',
      'CREATE TABLE pair (a INTEGER, b TEXT, PRIMARY KEY (b, a))',
    ]) {
      await runAll(session, sql);
    }
  }, 60_000);

  afterAll(async () => {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  it('reads AUTOINCREMENT, defaults, generated columns and key actions', async () => {
    const structure = await session.metadata.describeTable({ name: 'child' });
    expect(structure.columns.map((c) => [c.name, c.autoIncrement, c.generated])).toEqual([
      ['id', true, false],
      ['parent_id', false, false],
      ['label', false, false],
      ['made', false, false],
      ['twice', false, true],
    ]);
    expect(structure.columns[2]).toMatchObject({ defaultExpression: "'x'", nullable: false });
    expect(structure.columns[3]?.defaultExpression).toBe('CURRENT_TIMESTAMP');
    expect(structure.primaryKey).toEqual(['id']);
    expect(structure.foreignKeys).toEqual([
      expect.objectContaining({ onDelete: 'CASCADE', onUpdate: 'NO ACTION' }),
    ]);
  });

  it('lists what a rebuild has to create again', async () => {
    const structure = await session.metadata.describeTable({ name: 'child' });
    expect(structure.dependents).toEqual([
      {
        kind: 'index',
        name: 'ix_child_label',
        sql: 'CREATE INDEX ix_child_label ON child (label)',
      },
      {
        kind: 'index',
        name: 'ix_child_lower',
        sql: 'CREATE INDEX ix_child_lower ON child (lower(label))',
      },
      {
        kind: 'trigger',
        name: 'child_touch',
        sql: 'CREATE TRIGGER child_touch AFTER INSERT ON child BEGIN SELECT 1; END',
      },
    ]);
  });

  it('keeps the order of a composite key and does not call it auto-numbered', async () => {
    const structure = await session.metadata.describeTable({ name: 'pair' });
    expect(structure.primaryKey).toEqual(['b', 'a']);
    expect(structure.columns.every((column) => !column.autoIncrement)).toBe(true);
  });

  it('says not-found for a missing table', async () => {
    await expect(session.metadata.describeTable({ name: 'nope' })).rejects.toMatchObject({
      code: 'not-found',
    });
  });
});
