// The designer's rebuild of a real SQLite table keeps its CHECKs, WITHOUT ROWID / STRICT,
// indexes, triggers and views while the columns change.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver, Session } from '../../../src/drivers/driver';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { designFromStructure } from '../../../src/services/table-structure';
import type { TableDesign } from '../../../src/shared/table-design';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';
import { firstColumn, runAll } from '../../helpers/driver-run';

describe('sqlite designer rebuild', () => {
  let worker: BuiltWorker;
  let driver: Driver;
  let session: Session;
  let dir: string;

  async function alter(
    table: string,
    edit: (design: TableDesign) => TableDesign,
  ): Promise<readonly string[]> {
    const structure = await session.metadata.describeTable({ name: table });
    const loaded = designFromStructure({ name: table }, structure);
    const plan = driver.dialect.ddl.alterTable(
      { name: table },
      loaded.design,
      edit(loaded.design),
      loaded.background,
    );
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
    return plan.statements;
  }

  async function createText(table: string): Promise<string> {
    const [text] = firstColumn(
      await runAll(session, `SELECT sql FROM sqlite_master WHERE name = '${table}'`),
    );
    return typeof text === 'string' ? text : '';
  }

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    driver = createSqliteDriver({ workerPath: worker.workerPath });
    dir = mkdtempSync(join(tmpdir(), 'datanest-sqlite-rebuild-'));
    session = await driver.openSession({
      id: 'test-sqlite-rebuild',
      name: 'rebuild',
      driver: 'sqlite',
      file: join(dir, 'rebuild.db'),
    });
    await runAll(
      session,
      `CREATE TABLE products (
         id INTEGER PRIMARY KEY,
         price REAL NOT NULL CHECK (price > 0),
         qty INTEGER DEFAULT 1,
         note TEXT,
         CONSTRAINT qty_ok CHECK (qty >= 0),
         CONSTRAINT note_ok CHECK (note IS NULL OR length(note) < 50)
       )`,
    );
    await runAll(session, "INSERT INTO products (id, price, qty, note) VALUES (1, 5, 2, 'a')");
    await runAll(session, 'CREATE INDEX ix_price ON products (price)');
    await runAll(session, 'CREATE VIEW cheap AS SELECT id FROM products WHERE price < 6');
    await runAll(
      session,
      `CREATE TABLE strict_t (id INTEGER PRIMARY KEY, n INTEGER CHECK (n <> 13), s TEXT) STRICT`,
    );
    await runAll(session, `CREATE TABLE rowless (k TEXT PRIMARY KEY, v TEXT) WITHOUT ROWID`);
  });

  afterAll(async () => {
    await session.close();
    worker.dispose();
    rmSync(dir, { recursive: true, force: true });
  });

  it('keeps every check when a column changes type, and enforces them', async () => {
    await alter('products', (design) => ({
      ...design,
      columns: design.columns.map((c) => (c.name === 'qty' ? { ...c, type: 'bigint' } : c)),
    }));
    const text = await createText('products');
    expect(text).toMatch(/CHECK \(price > 0\)/);
    expect(text).toMatch(/qty_ok/);
    expect(text).toMatch(/note_ok/);
    await expect(
      runAll(session, 'INSERT INTO products (id, price, qty) VALUES (2, -1, 1)'),
    ).rejects.toThrow();
    await expect(
      runAll(session, 'INSERT INTO products (id, price, qty) VALUES (2, 1, -1)'),
    ).rejects.toThrow();
    expect(firstColumn(await runAll(session, 'SELECT id FROM cheap'))).toEqual([1]);
    expect(
      firstColumn(await runAll(session, "SELECT name FROM sqlite_master WHERE name='ix_price'")),
    ).toEqual(['ix_price']);
  });

  it('follows a renamed column into the conditions', async () => {
    await alter('products', (design) => ({
      ...design,
      columns: design.columns.map((c) =>
        c.name === 'price' ? { ...c, name: 'cost', type: 'numeric' } : c,
      ),
    }));
    const text = await createText('products');
    expect(text).toMatch(/CHECK \("?cost"? > 0\)/);
    expect(text).not.toMatch(/\bprice\b/);
    await expect(
      runAll(session, 'INSERT INTO products (id, cost, qty) VALUES (3, -1, 1)'),
    ).rejects.toThrow();
  });

  it('drops the checks of a dropped column and keeps the rest', async () => {
    const statements = await alter('products', (design) => ({
      ...design,
      columns: design.columns.filter((c) => c.name !== 'note'),
    }));
    expect(statements.join('\n')).toContain('-- CHECK note_ok is dropped with the column note');
    const text = await createText('products');
    expect(text).not.toMatch(/note/);
    expect(text).toMatch(/qty_ok/);
    expect(firstColumn(await runAll(session, 'SELECT count(*) FROM products'))).toEqual([1]);
  });

  it('keeps STRICT and WITHOUT ROWID', async () => {
    await alter('strict_t', (design) => ({
      ...design,
      columns: design.columns.map((c) =>
        c.name === 's' ? { ...c, nullable: false, defaultValue: "''" } : c,
      ),
    }));
    const strict = await createText('strict_t');
    expect(strict).toMatch(/STRICT\s*$/);
    expect(strict).toMatch(/n <> 13/);
    await expect(runAll(session, "INSERT INTO strict_t (id, n) VALUES (1, 'x')")).rejects.toThrow();

    await alter('rowless', (design) => ({
      ...design,
      columns: design.columns.map((c) =>
        c.name === 'v' ? { ...c, type: 'varchar', length: '9' } : c,
      ),
    }));
    expect(await createText('rowless')).toMatch(/WITHOUT ROWID\s*$/);
  });
});
