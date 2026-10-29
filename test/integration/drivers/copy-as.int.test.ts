// "Copy as" against real servers: the SQL it writes must read back as the very same
// values, quotes, backslashes, newlines and NULLs included.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { splitStatements } from '../../../src/core/sql/split';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { driver as clickhouseDriver } from '../../../src/drivers/clickhouse';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { QueryRunner } from '../../../src/services/query-runner';
import { ResultStore } from '../../../src/services/result-store';
import { ResultCopier } from '../../../src/services/result-copier';
import { cellText } from '../../../src/shared/cell-text';
import type { ConnectionInput, DriverId } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

interface Target {
  readonly label: string;
  readonly driver: DriverId;
  readonly input: () => ConnectionInput;
  readonly password?: string;
  /** DDL that creates `copy_src` with the same columns on every database. */
  readonly create: string;
  readonly drop: string;
}

function server(id: TestDatabaseId, driver: 'mysql' | 'postgres'): () => ConnectionInput {
  return () => {
    const db = testDatabase(id);
    return {
      name: id,
      driver,
      host: db.host,
      port: db.port,
      user: db.user,
      database: db.database,
    };
  };
}

describe('copy as', () => {
  let worker: BuiltWorker;
  let dir: string;

  beforeAll(async () => {
    worker = await buildSqliteWorker();
    dir = mkdtempSync(join(tmpdir(), 'datanest-copy-as-'));
  }, 60_000);

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const targets: Target[] = [
    {
      label: 'mysql',
      driver: 'mysql',
      input: server('mysql', 'mysql'),
      password: testDatabase('mysql').password,
      create:
        'CREATE TABLE copy_src (id INT PRIMARY KEY, name VARCHAR(100) NULL, price DECIMAL(10,2) NULL)',
      drop: 'DROP TABLE IF EXISTS copy_src',
    },
    {
      label: 'mariadb',
      driver: 'mysql',
      input: server('mariadb', 'mysql'),
      password: testDatabase('mariadb').password,
      create:
        'CREATE TABLE copy_src (id INT PRIMARY KEY, name VARCHAR(100) NULL, price DECIMAL(10,2) NULL)',
      drop: 'DROP TABLE IF EXISTS copy_src',
    },
    {
      label: 'postgres',
      driver: 'postgres',
      input: server('postgres', 'postgres'),
      password: testDatabase('postgres').password,
      create: 'CREATE TABLE copy_src (id INT PRIMARY KEY, name VARCHAR(100), price DECIMAL(10,2))',
      drop: 'DROP TABLE IF EXISTS copy_src',
    },
    {
      label: 'sqlite',
      driver: 'sqlite',
      input: () => ({ name: 'sqlite', driver: 'sqlite', file: join(dir, 'copy.db') }),
      create: 'CREATE TABLE copy_src (id INTEGER PRIMARY KEY, name TEXT, price NUMERIC)',
      drop: 'DROP TABLE IF EXISTS copy_src',
    },
  ];

  describe.each(targets)('$label', (target) => {
    let manager: ConnectionManager;
    let results: ResultStore;
    let runner: QueryRunner;
    let copier: ResultCopier;
    let drivers: Record<DriverId, Driver>;
    let connection: { connectionId: string };

    beforeAll(async () => {
      const logger = new RecordingLogger();
      const store = new ConnectionStore({
        state: new FakeMemento(),
        secrets: new FakeSecretStorage(),
        logger,
      });
      const sqlite = createSqliteDriver({ workerPath: worker.workerPath });
      drivers = {
        mysql: mysqlDriver,
        postgres: postgresDriver,
        sqlite,
        mssql: mssqlDriver,
        clickhouse: clickhouseDriver,
      };
      manager = new ConnectionManager({
        store,
        drivers: { get: (id) => Promise.resolve(drivers[id]) },
        logger,
      });
      results = new ResultStore();
      const cache = new MetadataCache({ logger });
      runner = new QueryRunner({
        manager,
        results,
        cache,
        limits: { rowLimit: () => 1000 },
        logger,
      });
      copier = new ResultCopier({ results, manager });
      connection = { connectionId: (await store.add(target.input(), target.password)).id };
      await sql(target.drop);
      await sql(target.create);
    }, 60_000);

    afterAll(async () => {
      await sql(target.drop);
      manager.dispose();
    });

    async function sql(text: string): Promise<void> {
      const outcome = await runner.run({
        documentUri: 'untitled:Setup.sql',
        target: connection,
        statements: splitStatements(text, target.driver),
      });
      const failed = outcome.results.find((result) => result.error !== undefined);
      if (failed?.error !== undefined) {
        throw new Error(`${text} → ${failed.error.message}`);
      }
    }

    const NAMES = ["it's", 'back\\slash', 'line1\nline2', 'Ünï; semi', '50%_off', null, ' padded '];

    async function seed(): Promise<void> {
      const dialect = drivers[target.driver].dialect;
      await sql('DELETE FROM copy_src');
      const values = NAMES.map(
        (name, index) =>
          `(${index + 1}, ${dialect.literal(name)}, ${index === 2 ? 'NULL' : `${index + 1}.25`})`,
      );
      await sql(`INSERT INTO copy_src (id, name, price) VALUES ${values.join(', ')}`);
    }

    async function load(): Promise<string> {
      const outcome = await runner.run({
        documentUri: 'untitled:Copy-1.sql',
        target: connection,
        statements: splitStatements('SELECT * FROM copy_src ORDER BY id', target.driver),
      });
      const [result] = outcome.results;
      if (result === undefined || result.error !== undefined) {
        throw new Error('could not read copy_src');
      }
      return result.id;
    }

    async function snapshot(): Promise<string[][]> {
      const id = await load();
      return (results.window(id, 0, 100)?.rows ?? []).map((row) =>
        row.map((cell) => cellText(cell, { nullText: '<NULL>' })),
      );
    }

    async function render(format: Parameters<ResultCopier['render']>[0]['format'], id: string) {
      const reply = await copier.render({ resultId: id, format });
      if (!reply.ok) {
        throw new Error(`refused: ${reply.error}`);
      }
      return reply.text;
    }

    it('writes INSERTs that rebuild exactly the same rows', async () => {
      await seed();
      const before = await snapshot();
      const text = await render('insert', await load());
      expect(text.split('\n').filter((line) => line.startsWith('INSERT'))).toHaveLength(
        NAMES.length,
      );
      await sql('DELETE FROM copy_src');
      await sql(text);
      expect(await snapshot()).toEqual(before);
    });

    it('writes UPDATEs that put every value back', async () => {
      await seed();
      const before = await snapshot();
      const text = await render('update', await load());
      await sql("UPDATE copy_src SET name = 'changed', price = 0");
      expect(await snapshot()).not.toEqual(before);
      await sql(text);
      expect(await snapshot()).toEqual(before);
    });

    it('writes an IN list that finds the same rows', async () => {
      await seed();
      const id = await load();
      const list = await copier.render({ resultId: id, format: 'in', columns: [1] });
      if (!list.ok) {
        throw new Error(list.error);
      }
      const found = await runner.run({
        documentUri: 'untitled:Copy-2.sql',
        target: connection,
        statements: splitStatements(
          `SELECT COUNT(*) FROM copy_src WHERE name IN ${list.text}`,
          target.driver,
        ),
      });
      const count =
        found.results[0] === undefined ? undefined : results.window(found.results[0].id, 0, 1);
      // Six names are not NULL; the NULL row can never match an IN list.
      expect(cellText(count?.rows[0]?.[0] ?? null)).toBe('6');
    });

    it('writes CSV, JSON and Markdown that keep the awkward values intact', async () => {
      await seed();
      const id = await load();
      const json = JSON.parse(await render('json', id)) as { name: string | null }[];
      expect(json.map((row) => row.name)).toEqual(NAMES);
      expect(await render('csv', id)).toContain('"line1\nline2"');
      expect(await render('markdown', id)).toContain('line1<br>line2');
    });
  });
});
