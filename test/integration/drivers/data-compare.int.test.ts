// Comparing table data on real servers (V8.4), across kinds of database: values that
// are spelled differently (10.50 and 10.5, a flag as 1 and as true) are the same, and
// the sync script, run on the target, leaves nothing to sync.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { TableRef } from '../../../src/core/model/objects';
import { splitStatements } from '../../../src/core/sql/split';
import type { Driver, Session } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { pairColumns } from '../../../src/services/data-compare/column-pairs';
import { compareTableData } from '../../../src/services/data-compare/data-compare';
import {
  DataCompareModel,
  type DataCompareSide,
} from '../../../src/vscode/panels/data-compare-model';
import type { DriverId, ResolvedConnectionConfig } from '../../../src/shared/connection';
import { testDatabase } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker;
let dir: string;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  dir = mkdtempSync(join(tmpdir(), 'datanest-datacmp-'));
}, 60_000);

afterAll(() => {
  worker.dispose();
  rmSync(dir, { recursive: true, force: true });
});

function server(id: 'mysql' | 'postgres'): ResolvedConnectionConfig {
  const db = testDatabase(id);
  return {
    id: `dc-${id}`,
    name: id,
    driver: id,
    host: db.host,
    port: db.port,
    user: db.user,
    password: db.password,
    database: db.database,
  };
}

interface End {
  readonly driver: () => Driver;
  readonly driverId: DriverId;
  readonly config: () => ResolvedConnectionConfig;
  readonly table: TableRef;
  readonly setup: readonly string[];
  readonly teardown: readonly string[];
}

interface Pair {
  readonly label: string;
  readonly source: End;
  readonly target: End;
  readonly transactions: boolean;
}

const PAIRS: readonly Pair[] = [
  {
    label: 'MySQL → PostgreSQL',
    source: {
      driver: () => mysqlDriver,
      driverId: 'mysql',
      config: () => server('mysql'),
      table: { database: 'datanest_test', name: 'dc_items' },
      setup: [
        'DROP TABLE IF EXISTS dc_items',
        `CREATE TABLE dc_items (id INT PRIMARY KEY, name VARCHAR(50) NOT NULL, price DECIMAL(10,2),
           active BOOLEAN, made DATETIME, note TEXT)`,
        `INSERT INTO dc_items VALUES
           (1, 'tea', 10.50, TRUE, '2024-01-02 08:00:00', NULL),
           (2, 'coffee', 7.00, FALSE, '2024-02-03 09:30:00', 'strong'),
           (3, 'milk', 2.25, TRUE, NULL, 'cold'),
           (4, 'juice', 3.10, TRUE, '2024-03-04 10:00:00', 'new'),
           (5, 'water', 0.99, FALSE, NULL, NULL)`,
      ],
      teardown: ['DROP TABLE IF EXISTS dc_items'],
    },
    target: {
      driver: () => postgresDriver,
      driverId: 'postgres',
      config: () => server('postgres'),
      table: { schema: 'public', name: 'dc_items' },
      setup: [
        'DROP TABLE IF EXISTS public.dc_items',
        `CREATE TABLE public.dc_items (id int PRIMARY KEY, name varchar(50) NOT NULL, price numeric(10,3),
           active boolean, made timestamp, note text, extra int)`,
        `INSERT INTO public.dc_items VALUES
           (1, 'tea', 10.5, true, '2024-01-02 08:00:00', NULL, 1),
           (2, 'coffee', 7.000, false, '2024-02-03 09:30:00', 'strong', 2),
           (3, 'MILK', 2.25, true, NULL, NULL, 3),
           (5, 'water', 0.99, true, NULL, NULL, 5),
           (6, 'soda', 1.5, false, NULL, 'gone', 6)`,
      ],
      teardown: ['DROP TABLE IF EXISTS public.dc_items'],
    },
    transactions: true,
  },
  {
    label: 'PostgreSQL → SQLite, composite key',
    source: {
      driver: () => postgresDriver,
      driverId: 'postgres',
      config: () => server('postgres'),
      table: { schema: 'public', name: 'dc_pairs' },
      setup: [
        'DROP TABLE IF EXISTS public.dc_pairs',
        `CREATE TABLE public.dc_pairs (a int, b text, n bigint, payload jsonb, PRIMARY KEY (a, b))`,
        `INSERT INTO public.dc_pairs VALUES
           (1, 'x', 9007199254740993, '{"k": 1, "j": [1, 2]}'),
           (1, 'y', 2, NULL),
           (2, 'x', 3, '{"z": true}')`,
      ],
      teardown: ['DROP TABLE IF EXISTS public.dc_pairs'],
    },
    target: {
      driver: () => createSqliteDriver({ workerPath: worker.workerPath }),
      driverId: 'sqlite',
      config: () => ({
        id: 'dc-sqlite',
        name: 'sqlite',
        driver: 'sqlite',
        file: join(dir, 'dc.db'),
      }),
      table: { name: 'dc_pairs' },
      setup: [
        'DROP TABLE IF EXISTS dc_pairs',
        'CREATE TABLE dc_pairs (a INTEGER, b TEXT, n INTEGER, payload TEXT, PRIMARY KEY (a, b))',
        `INSERT INTO dc_pairs VALUES (1, 'x', 9007199254740993, '{"j":[1,2],"k":1}'), (1, 'y', 5, NULL)`,
      ],
      teardown: [],
    },
    transactions: true,
  },
];

describe.each(PAIRS)('data comparison $label', (pair) => {
  let source: Session;
  let target: Session;

  beforeAll(async () => {
    source = await pair.source.driver().openSession(pair.source.config());
    target = await pair.target.driver().openSession(pair.target.config());
    for (const sql of pair.source.setup) {
      await runAll(source, sql);
    }
    for (const sql of pair.target.setup) {
      await runAll(target, sql);
    }
  }, 60_000);

  afterAll(async () => {
    for (const sql of pair.source.teardown) {
      await runAll(source, sql);
    }
    for (const sql of pair.target.teardown) {
      await runAll(target, sql);
    }
    await source.close();
    await target.close();
  });

  async function model(): Promise<DataCompareModel> {
    const side = async (end: End, session: Session, label: string): Promise<DataCompareSide> => ({
      label,
      table: end.table,
      dialect: end.driver().dialect,
      driver: end.driverId,
      structure: await session.metadata.describeTable(end.table),
      session: () => Promise.resolve(session),
      release: () => Promise.resolve(),
    });
    const from = await side(pair.source, source, 'source');
    const to = await side(pair.target, target, 'target');
    const plan = pairColumns(from.structure, to.structure);
    const keys = new Set(plan.key.map((column) => column.source));
    return new DataCompareModel({
      source: from,
      target: to,
      key: plan.key,
      columns: plan.pairs.filter((column) => !keys.has(column.source)),
      sourceOnly: plan.sourceOnly,
      targetOnly: plan.targetOnly,
      transactions: pair.transactions,
    });
  }

  it('counts the same, different and missing rows, whatever the spelling of values', async () => {
    const compared = await model();
    await compared.run();
    const state = compared.state();
    expect(state.error).toBeUndefined();
    if (pair.source.driverId === 'mysql') {
      expect(state.targetOnly).toEqual(['extra']);
      expect(state.result).toMatchObject({ same: 2, different: 2, onlySource: 1, onlyTarget: 1 });
      const different = compared.rows('different', 0, 10);
      expect(different.map((row) => row.cells[0])).toEqual(['3', '5']);
      // Only the name and note of milk differ; the price 2.25 is 2.250 in the target.
      expect(different[0]?.differs).toEqual([false, true, false, false, false, true]);
      expect(compared.rows('onlyTarget', 0, 10)[0]?.cells.slice(0, 2)).toEqual(['6', 'soda']);
    } else {
      expect(state.result).toMatchObject({ same: 1, different: 1, onlySource: 1, onlyTarget: 0 });
    }
  });

  it('writes a sync script that leaves nothing to sync', async () => {
    const compared = await model();
    await compared.run();
    const script = compared.script({ insert: true, update: true, delete: true }, new Date(0));
    for (const statement of splitStatements(script, pair.target.driverId)) {
      await runAll(target, statement.text);
    }
    const again = await model();
    await again.run();
    expect(again.state().result).toMatchObject({ different: 0, onlySource: 0, onlyTarget: 0 });
  });

  it('refuses a key whose values repeat', async () => {
    const from = await source.metadata.describeTable(pair.source.table);
    const plan = pairColumns(from, await target.metadata.describeTable(pair.target.table));
    const loose = plan.pairs.filter(
      (column) => !plan.key.some((key) => key.source === column.source),
    );
    const side = (end: End, session: Session) => ({
      table: end.table,
      dialect: end.driver().dialect,
      session: () => Promise.resolve(session),
      release: () => Promise.resolve(),
    });
    // A column whose values repeat: `active` in the first table, `b` in the second.
    const repeating = pair.source.driverId === 'mysql' ? 'active' : 'b';
    const key = plan.pairs.filter((column) => column.source === repeating);
    await expect(
      compareTableData({
        source: side(pair.source, source),
        target: side(pair.target, target),
        key,
        columns: loose.filter((column) => column.source !== repeating),
      }),
    ).rejects.toMatchObject({ code: 'constraint' });
  });
});
