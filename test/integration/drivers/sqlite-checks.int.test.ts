// CHECK constraints of a real SQLite file: read from the stored CREATE text, added and
// dropped by the rebuild the driver plans, with rows, indexes, triggers and views kept.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { checkPlanFor } from '../../../src/services/table-checks';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';
import { firstColumn, runAll } from '../../helpers/driver-run';

describe('sqlite checks', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let session: Session;
  let dir: string;

  async function change(
    table: string,
    action: 'add' | 'drop',
    name: string,
    expression?: string,
  ): Promise<void> {
    const structure = await session.metadata.describeTable({ name: table });
    const plan = checkPlanFor(driver.dialect, { name: table }, structure, {
      action,
      name,
      ...(expression === undefined ? {} : { expression }),
    });
    try {
      for (const statement of plan.statements) {
        await runAll(session, statement);
      }
    } catch (error) {
      // What the schema actions do after a failed statement.
      for (const statement of plan.recovery) {
        await runAll(session, statement).catch(() => undefined);
      }
      throw error;
    }
  }

  async function names(table: string): Promise<string[]> {
    const structure = await session.metadata.describeTable({ name: table });
    return (structure.checks ?? []).map((check) => check.name);
  }

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-sqlite-checks-'));
    session = await driver.openSession({
      id: 'test-sqlite-checks',
      name: 'checks',
      driver: 'sqlite',
      file: join(dir, 'checks.db'),
    });
    await runAll(
      session,
      `CREATE TABLE products (
         id INTEGER PRIMARY KEY,
         price REAL NOT NULL CHECK (price > 0),
         qty INTEGER DEFAULT 1,
         note TEXT DEFAULT 'CHECK (x)',
         CONSTRAINT qty_ok CHECK (qty >= 0)
       )`,
    );
    await runAll(session, `INSERT INTO products (id, price, qty) VALUES (1, 5, 2), (2, 7, 0)`);
    await runAll(session, 'CREATE INDEX ix_price ON products (price)');
    await runAll(session, 'CREATE TABLE audit (n INTEGER)');
    await runAll(
      session,
      `CREATE TRIGGER trg_products AFTER INSERT ON products BEGIN INSERT INTO audit VALUES (new.id); END`,
    );
    await runAll(session, 'CREATE VIEW cheap AS SELECT id FROM products WHERE price < 6');
    await runAll(
      session,
      'CREATE TABLE items (id INTEGER PRIMARY KEY, product INTEGER REFERENCES products(id))',
    );
    await runAll(session, 'INSERT INTO items VALUES (1, 1)');
  });

  afterAll(async () => {
    await session.close();
    worker.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('lists the checks written in the table', async () => {
    expect(await names('products')).toEqual(['unnamed_check_1', 'qty_ok']);
  });

  it('adds a check: it is enforced, rows and everything around the table stay', async () => {
    await change('products', 'add', 'price_small', 'price < 1000');
    expect(await names('products')).toEqual(['unnamed_check_1', 'qty_ok', 'price_small']);
    await expect(
      runAll(session, 'INSERT INTO products (id, price) VALUES (3, 5000)'),
    ).rejects.toThrow();
    expect(firstColumn(await runAll(session, 'SELECT count(*) FROM products'))).toEqual([2]);
    expect(
      firstColumn(await runAll(session, "SELECT name FROM sqlite_master WHERE name = 'ix_price'")),
    ).toEqual(['ix_price']);
    expect(
      firstColumn(
        await runAll(session, "SELECT name FROM sqlite_master WHERE name = 'trg_products'"),
      ),
    ).toEqual(['trg_products']);
    // The trigger still works, the view still reads, the rows of other tables are intact.
    await runAll(session, 'INSERT INTO products (id, price) VALUES (4, 5)');
    expect(firstColumn(await runAll(session, 'SELECT n FROM audit'))).toEqual([4]);
    expect(firstColumn(await runAll(session, 'SELECT id FROM cheap ORDER BY id'))).toEqual([1, 4]);
    expect((await runAll(session, 'PRAGMA foreign_key_check')).rows).toEqual([]);
    expect(firstColumn(await runAll(session, 'SELECT product FROM items'))).toEqual([1]);
    await runAll(session, 'DELETE FROM products WHERE id = 4');
  });

  it('drops a named check and one without a name', async () => {
    await change('products', 'drop', 'price_small');
    await runAll(session, 'INSERT INTO products (id, price) VALUES (5, 5000)');
    await runAll(session, 'DELETE FROM products WHERE id = 5');
    await change('products', 'drop', 'unnamed_check_1');
    await runAll(session, 'INSERT INTO products (id, price) VALUES (6, -1)');
    await runAll(session, 'DELETE FROM products WHERE id = 6');
    expect(await names('products')).toEqual(['qty_ok']);
    await expect(
      runAll(session, 'INSERT INTO products (id, price, qty) VALUES (7, 1, -5)'),
    ).rejects.toThrow();
    // The text of a default that looks like a check was left alone.
    expect(
      firstColumn(
        await runAll(session, "SELECT sql FROM sqlite_master WHERE name = 'products'"),
      )[0],
    ).toContain("DEFAULT 'CHECK (x)'");
  });

  it('refuses a condition the rows break, and leaves the table as it was', async () => {
    await expect(change('products', 'add', 'never', 'price > 100')).rejects.toThrow();
    expect(await names('products')).toEqual(['qty_ok']);
    expect(firstColumn(await runAll(session, 'SELECT count(*) FROM products'))).toEqual([2]);
    expect(
      firstColumn(
        await runAll(session, "SELECT name FROM sqlite_master WHERE name LIKE '%rebuild'"),
      ),
    ).toEqual([]);
  });
});
