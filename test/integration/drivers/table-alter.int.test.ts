// ALTER from the designer on the real servers. Each change is applied, the table is
// read back, and it must be the table that was designed — with its rows intact and
// nothing left for a second ALTER to do.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableRef } from '../../../src/core/model/objects';
import type { AlterPlan, Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { designFromStructure, type LoadedTable } from '../../../src/services/table-structure';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import {
  type ColumnDesign,
  composeType,
  designProblems,
  type TableDesign,
} from '../../../src/shared/table-design';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

function serverConfig(id: TestDatabaseId, driver: DriverId): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `alter-${id}`,
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

async function load(session: Session, table: TableRef): Promise<LoadedTable> {
  return designFromStructure(table, await session.metadata.describeTable(table));
}

/** Plans the change, runs it (recovering on failure, like SchemaActions), reads it back. */
async function apply(
  session: Session,
  driver: Driver,
  table: TableRef,
  change: (design: TableDesign) => TableDesign,
): Promise<{ plan: AlterPlan; after: TableDesign; reloaded: LoadedTable }> {
  const loaded = await load(session, table);
  const after = change(loaded.design);
  expect(designProblems(after, driver.id)).toEqual([]);
  const plan = driver.dialect.ddl.alterTable(table, loaded.design, after, loaded.background);
  try {
    for (const statement of plan.statements) {
      await runAll(session, statement);
    }
  } catch (error) {
    for (const statement of plan.recovery) {
      await runAll(session, statement).catch(() => undefined);
    }
    throw error;
  }
  const reloaded = await load(session, { ...table, name: after.name.trim() });
  // Nothing is left to do: the stored table is the designed one.
  expect(
    driver.dialect.ddl.alterTable(
      { ...table, name: after.name.trim() },
      reloaded.design,
      reloaded.design,
      reloaded.background,
    ).statements,
  ).toEqual([]);
  return { plan, after, reloaded };
}

/** A design in a form two servers' spellings can be compared in. */
function shape(design: TableDesign) {
  const nameOf = new Map(design.columns.map((c) => [c.id, c.name.trim()]));
  return {
    name: design.name,
    comment: design.comment,
    columns: design.columns.map((c) => ({
      name: c.name.trim(),
      type: composeType(c.type, c.length)
        .toLowerCase()
        .replace(/\s*,\s*/g, ',')
        .replace(/^(\w*int)\(\d+\)/, '$1'),
      nullable: c.nullable,
      // PostgreSQL adds casts to literals: 'x'::text is 'x'.
      hasDefault: c.defaultValue.trim() !== '',
      autoIncrement: c.autoIncrement,
      primaryKey: c.primaryKey,
      comment: c.comment,
    })),
    indexes: design.indexes
      .map((i) => ({
        name: i.name,
        unique: i.unique,
        columns: i.columns.map((id) => nameOf.get(id)),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    foreignKeys: design.foreignKeys.map((k) => ({
      name: k.name,
      columns: k.columns.map((id) => nameOf.get(id)),
      targetTable: k.targetTable,
      targetColumns: k.targetColumns,
      onDelete: k.onDelete,
      onUpdate: k.onUpdate,
    })),
  };
}

function col(name: string, overrides: Partial<ColumnDesign> = {}): ColumnDesign {
  return {
    id: `new-${name}`,
    name,
    type: 'int',
    length: '',
    nullable: true,
    defaultValue: '',
    autoIncrement: false,
    primaryKey: false,
    comment: '',
    ...overrides,
  };
}

function edit(design: TableDesign, name: string, patch: Partial<ColumnDesign>): TableDesign {
  return {
    ...design,
    columns: design.columns.map((c) => (c.name === name ? { ...c, ...patch } : c)),
  };
}

function idOf(design: TableDesign, name: string): string {
  const found = design.columns.find((c) => c.name === name);
  if (found === undefined) {
    throw new Error(`no column ${name}`);
  }
  return found.id;
}

describe.each(['mysql', 'mariadb'] as const)('ALTER on %s', (serverId) => {
  let session: Session;
  const database = testDatabase(serverId).database;
  const table = { database, name: 'alter_probe' };

  beforeAll(async () => {
    session = await mysqlDriver.openSession(serverConfig(serverId, 'mysql'));
    await runAll(session, 'DROP TABLE IF EXISTS alter_probe, alter_probe2');
    await runAll(
      session,
      `CREATE TABLE alter_probe (
         id INT AUTO_INCREMENT PRIMARY KEY,
         customer_id INT NOT NULL,
         note VARCHAR(40) DEFAULT 'x',
         price DECIMAL(10,2),
         made DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
         KEY ix_note (note),
         CONSTRAINT fk_probe_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
       )`,
    );
    await runAll(
      session,
      "INSERT INTO alter_probe (customer_id, note, price) VALUES (1, 'first', 1.50), (2, 'second', 2.00)",
    );
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS alter_probe, alter_probe2');
    await session.close();
  });

  it('applies many changes at once and keeps the rows', async () => {
    const { after, reloaded } = await apply(session, mysqlDriver, table, (design) => {
      const renamed = edit(design, 'note', {
        name: 'remark',
        length: '100',
        nullable: false,
        defaultValue: "'-'",
        comment: 'free text',
      });
      const [id, ...rest] = renamed.columns.filter((c) => c.name !== 'price');
      return {
        ...renamed,
        name: 'alter_probe2',
        comment: "probe's",
        columns: [
          col('rank'),
          ...(id === undefined ? [] : [id]),
          col('total', { type: 'decimal', length: '12,2', defaultValue: '0' }),
          ...rest,
        ],
        indexes: [
          {
            id: 'index-9',
            name: 'uq_customer_remark',
            columns: [idOf(renamed, 'customer_id'), idOf(renamed, 'remark')],
            unique: true,
          },
        ],
        foreignKeys: renamed.foreignKeys.map((k) => ({ ...k, onDelete: 'CASCADE' })),
      };
    });
    const intended = shape(after);
    const actual = shape(reloaded.design);
    // MySQL keeps an index for the key's own columns; it shows up as one more index.
    expect({
      ...actual,
      indexes: actual.indexes.filter((i) => i.name !== 'fk_probe_customer'),
    }).toEqual({
      ...intended,
      columns: intended.columns.map((c) =>
        c.name === 'id' ? { ...c, type: actual.columns[1]?.type ?? c.type } : c,
      ),
    });
    const rows = await runAll(session, 'SELECT id, remark, total FROM alter_probe2 ORDER BY id');
    expect(rows.rows).toEqual([
      [1, 'first', { kind: 'decimal', text: '0.00' }],
      [2, 'second', { kind: 'decimal', text: '0.00' }],
    ]);
  });

  it('keeps ON UPDATE CURRENT_TIMESTAMP when the column is rewritten', async () => {
    const renamed = { ...table, name: 'alter_probe2' };
    await apply(session, mysqlDriver, renamed, (design) =>
      edit(design, 'made', { comment: 'touched' }),
    );
    const structure = await session.metadata.describeTable(renamed);
    const made = structure.columns.find((c) => c.name === 'made');
    expect(made?.defaultExpression?.toLowerCase()).toMatch(/on update current_timestamp/);
    expect(made?.comment).toBe('touched');
  });

  it('moves a column without touching the others', async () => {
    const renamed = { ...table, name: 'alter_probe2' };
    const { plan, reloaded } = await apply(session, mysqlDriver, renamed, (design) => {
      const last = design.columns.at(-1);
      return {
        ...design,
        columns: last === undefined ? design.columns : [last, ...design.columns.slice(0, -1)],
      };
    });
    expect(plan.statements).toHaveLength(1);
    expect(plan.statements[0]?.match(/CHANGE COLUMN/g)).toHaveLength(1);
    expect(reloaded.design.columns[0]?.name).toBe('made');
  });

  it('changes the primary key', async () => {
    const renamed = { ...table, name: 'alter_probe2' };
    const { reloaded } = await apply(session, mysqlDriver, renamed, (design) =>
      edit(design, 'customer_id', { primaryKey: true }),
    );
    expect(reloaded.design.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual([
      'id',
      'customer_id',
    ]);
  });
});

describe('ALTER on postgres', () => {
  let session: Session;
  const table = { schema: 'public', name: 'alter_probe' };

  beforeAll(async () => {
    session = await postgresDriver.openSession(serverConfig('postgres', 'postgres'));
    await runAll(session, 'DROP TABLE IF EXISTS alter_probe, alter_probe2 CASCADE');
    await runAll(
      session,
      `CREATE TABLE alter_probe (
         id integer GENERATED BY DEFAULT AS IDENTITY,
         customer_id integer NOT NULL,
         code text,
         amount text DEFAULT '0',
         CONSTRAINT alter_probe_pk PRIMARY KEY (id),
         CONSTRAINT alter_probe_code UNIQUE (code),
         CONSTRAINT alter_probe_customer FOREIGN KEY (customer_id) REFERENCES customers (id)
       )`,
    );
    await runAll(session, 'CREATE INDEX ix_alter_probe_lower ON alter_probe (lower(code))');
    await runAll(
      session,
      "INSERT INTO alter_probe (customer_id, code, amount) VALUES (1, 'a', '10'), (2, 'b', '20')",
    );
  });

  afterAll(async () => {
    await runAll(session, 'DROP TABLE IF EXISTS alter_probe, alter_probe2 CASCADE');
    await session.close();
  });

  it('changes types with conversion, defaults, keys and names in one transaction', async () => {
    const { after, reloaded, plan } = await apply(session, postgresDriver, table, (design) => {
      const changed = edit(
        edit(design, 'amount', { type: 'integer', defaultValue: '0', nullable: false }),
        'code',
        {
          name: 'label',
          comment: 'shown',
        },
      );
      return {
        ...changed,
        name: 'alter_probe2',
        comment: 'probe',
        columns: [...changed.columns, col('rank', { type: 'smallint', comment: 'r' })],
        // The UNIQUE constraint behind alter_probe_code goes, a plain index comes.
        indexes: [
          {
            id: 'index-9',
            name: 'ix_alter_probe_label',
            columns: [idOf(changed, 'label')],
            unique: false,
          },
        ],
        foreignKeys: changed.foreignKeys.map((k) => ({ ...k, onDelete: 'CASCADE' })),
      };
    });
    expect(plan.statements[0]).toBe('BEGIN');
    expect(shape(reloaded.design)).toEqual(shape(after));
    // The expression index is not designable and survived untouched.
    expect(reloaded.background.fixedIndexes.map((i) => i.name)).toEqual(['ix_alter_probe_lower']);
    const rows = await runAll(session, 'SELECT id, label, amount FROM alter_probe2 ORDER BY id');
    expect(rows.rows).toEqual([
      [1, 'a', 10],
      [2, 'b', 20],
    ]);
  });

  it('drops and adds identity, and replaces the primary key under its own name', async () => {
    const renamed = { ...table, name: 'alter_probe2' };
    const { reloaded } = await apply(session, postgresDriver, renamed, (design) =>
      edit(edit(design, 'id', { autoIncrement: false }), 'customer_id', { primaryKey: true }),
    );
    expect(reloaded.design.columns.find((c) => c.name === 'id')?.autoIncrement).toBe(false);
    expect(reloaded.design.columns.filter((c) => c.primaryKey).map((c) => c.name)).toEqual([
      'id',
      'customer_id',
    ]);
    const back = await apply(session, postgresDriver, renamed, (design) =>
      edit(design, 'id', { autoIncrement: true }),
    );
    expect(back.reloaded.design.columns.find((c) => c.name === 'id')?.autoIncrement).toBe(true);
  });

  it('rolls everything back when one statement fails', async () => {
    const renamed = { ...table, name: 'alter_probe2' };
    // 'abc' cannot become an integer, so the second change fails after the first ran.
    await runAll(session, "UPDATE alter_probe2 SET label = 'abc'");
    await expect(
      apply(session, postgresDriver, renamed, (design) =>
        edit(edit(design, 'rank', { name: 'position' }), 'label', { type: 'integer' }),
      ),
    ).rejects.toMatchObject({ message: expect.stringContaining('integer') as unknown });
    const structure = await session.metadata.describeTable(renamed);
    expect(structure.columns.map((c) => c.name)).toContain('rank');
    expect(structure.columns.map((c) => c.name)).not.toContain('position');
  });

  it('applies other changes and says the new order is not applied', async () => {
    const renamed = { ...table, name: 'alter_probe2' };
    const { plan, reloaded } = await apply(session, postgresDriver, renamed, (design) => ({
      ...design,
      columns: [col('first'), ...design.columns],
    }));
    expect(plan.notes).toEqual(['order-ignored']);
    expect(reloaded.design.columns.at(-1)?.name).toBe('first');
  });
});

describe('ALTER on sqlite', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let dir: string;
  let session: Session;
  const table = { name: 'items' };

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-alter-'));
    session = await driver.openSession({
      id: 'alter-sqlite',
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'alter.db'),
    });
    for (const sql of [
      'CREATE TABLE owners (id INTEGER PRIMARY KEY, name TEXT)',
      "INSERT INTO owners VALUES (1, 'a'), (2, 'b')",
      `CREATE TABLE items (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         owner_id INTEGER,
         label TEXT NOT NULL DEFAULT 'x',
         price TEXT,
         code TEXT UNIQUE
       )`,
      'CREATE INDEX ix_items_label ON items (label)',
      'CREATE INDEX ix_items_lower ON items (lower(label))',
      'CREATE TABLE log (item INTEGER, what TEXT)',
      "CREATE TRIGGER items_log AFTER INSERT ON items BEGIN INSERT INTO log VALUES (NEW.id, 'added'); END",
      'CREATE VIEW item_labels AS SELECT id, label FROM items',
      "INSERT INTO items (owner_id, label, price, code) VALUES (1, 'one', '1.5', 'c1'), (2, 'two', '2', 'c2')",
    ]) {
      await runAll(session, sql);
    }
  }, 60_000);

  afterAll(async () => {
    await session.close();
    rmSync(dir, { recursive: true, force: true });
    worker.dispose();
  });

  it('renames, adds a column and an index in place', async () => {
    const { plan, after, reloaded } = await apply(session, driver, table, (design) => ({
      ...edit(design, 'price', { name: 'cost' }),
      columns: [
        ...edit(design, 'price', { name: 'cost' }).columns,
        col('note', { type: 'text', defaultValue: "'-'" }),
      ],
    }));
    expect(plan.notes).toEqual([]);
    expect(shape(reloaded.design)).toEqual(shape(after));
  });

  it('rebuilds for type and key changes, keeping rows, the trigger, the view and odd indexes', async () => {
    const { plan, after, reloaded } = await apply(session, driver, table, (design) => {
      const changed = edit(edit(design, 'cost', { type: 'real' }), 'label', { name: 'title' });
      return {
        ...changed,
        name: 'goods',
        columns: changed.columns.filter((c) => c.name !== 'note'),
        foreignKeys: [
          {
            id: 'key-9',
            name: 'fk_goods_owner',
            columns: [idOf(changed, 'owner_id')],
            targetTable: 'owners',
            targetColumns: ['id'],
            onDelete: 'CASCADE',
            onUpdate: 'NO ACTION',
          },
        ],
      };
    });
    expect(plan.notes).toEqual(['rebuild']);
    expect(shape(reloaded.design)).toEqual({
      ...shape(after),
      // SQLite names keys by position; the designer's name does not survive.
      foreignKeys: shape(after).foreignKeys.map((k) => ({ ...k, name: 'fk_1' })),
    });
    const rows = await runAll(session, 'SELECT id, title, cost, code FROM goods ORDER BY id');
    expect(rows.rows).toEqual([
      [1, 'one', 1.5, 'c1'],
      [2, 'two', 2, 'c2'],
    ]);
    // The view and the trigger read and fire on the rebuilt table, AUTOINCREMENT goes on.
    await runAll(session, "INSERT INTO goods (owner_id, title) VALUES (1, 'three')");
    expect((await runAll(session, 'SELECT id FROM goods ORDER BY id DESC LIMIT 1')).rows).toEqual([
      [3],
    ]);
    expect((await runAll(session, 'SELECT COUNT(*) FROM log WHERE item = 3')).rows).toEqual([[1]]);
    const structure = await session.metadata.describeTable({ name: 'goods' });
    // The UNIQUE of the old CREATE TABLE comes back as a unique index of its own.
    expect(structure.dependents?.map((d) => d.name)).toEqual([
      'ix_items_label',
      'ix_items_lower',
      'uq_items_code',
      'items_log',
    ]);
    // The view followed both the renamed column and the renamed table.
    expect((await runAll(session, 'SELECT COUNT(*) FROM item_labels')).rows).toEqual([[3]]);
    expect((await runAll(session, 'SELECT title FROM item_labels WHERE id = 1')).rows).toEqual([
      ['one'],
    ]);
    expect(structure.columns[0]).toMatchObject({ name: 'id', autoIncrement: true });
  });

  it('keeps the old table when a rebuild fails', async () => {
    const before = await session.metadata.describeTable({ name: 'goods' });
    await expect(
      apply(session, driver, { name: 'goods' }, (design) => ({
        ...design,
        // The rows hold two owners: a unique key over owner_id alone is fine, but over a
        // constant default column it collides once the rows are copied.
        columns: [
          ...design.columns,
          col('flag', { type: 'integer', nullable: false, defaultValue: '1' }),
        ],
        indexes: [
          ...design.indexes,
          { id: 'index-9', name: 'uq_flag', columns: ['new-flag'], unique: true },
        ],
      })),
    ).rejects.toMatchObject({ code: 'constraint' });
    expect(await session.metadata.describeTable({ name: 'goods' })).toEqual(before);
    expect((await runAll(session, 'SELECT COUNT(*) FROM goods')).rows).toEqual([[3]]);
  });
});
