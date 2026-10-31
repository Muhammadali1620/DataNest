// "Find Data…" and "Document Database…" (V10.2.6) on MySQL, MariaDB, PostgreSQL and a
// SQLite file; the search checks are in helpers/data-search-suite.ts.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { readSchemaSnapshot } from '../../../src/services/schema-compare/snapshot';
import { schemaDocument } from '../../../src/services/schema-docs';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import {
  type DataSearchPlace,
  dataSearchSuite,
  SEARCH_ROWS,
} from '../../helpers/data-search-suite';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

let worker: BuiltWorker | undefined;
const dir = mkdtempSync(join(tmpdir(), 'datanest-find-'));

beforeAll(async () => {
  worker = await buildSqliteWorker();
});

afterAll(() => {
  worker?.dispose();
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function rows(quote: (text: string) => string): string {
  return SEARCH_ROWS.map(
    ([note, title], index) =>
      `(${index + 1}, ${note === null ? 'NULL' : quote(note)}, ${quote(title)}, ${index * 7})`,
  ).join(', ');
}

const sqlString = (text: string): string => `'${text.replaceAll("'", "''")}'`;

function server(id: Extract<TestDatabaseId, 'mysql' | 'mariadb' | 'postgres'>): DataSearchPlace {
  const postgres = id === 'postgres';
  return {
    label: id,
    driver: () => (postgres ? postgresDriver : mysqlDriver),
    config: () => {
      const db = testDatabase(id);
      return {
        id: `find-${id}`,
        name: id,
        driver: postgres ? 'postgres' : 'mysql',
        host: db.host,
        port: db.port,
        user: db.user,
        password: db.password,
        database: 'datanest_empty',
      };
    },
    id: postgres ? 'postgres' : 'mysql',
    scope: postgres
      ? { database: 'datanest_empty', schema: 'public' }
      : { database: 'datanest_empty' },
    create: [
      'CREATE TABLE find_me (id INT PRIMARY KEY, note TEXT NULL, title VARCHAR(50) NOT NULL, n INT NOT NULL)',
      `INSERT INTO find_me VALUES ${rows(sqlString)}`,
    ],
    drop: ['DROP TABLE IF EXISTS find_me'],
    name: 'find_me',
    reported: (name) => name,
  };
}

dataSearchSuite(server('mysql'));
dataSearchSuite(server('mariadb'));
dataSearchSuite(server('postgres'));
dataSearchSuite({
  label: 'sqlite',
  driver: () => {
    if (worker === undefined) {
      throw new Error('The SQLite worker is not built yet');
    }
    return createSqliteDriver({ workerPath: worker.workerPath });
  },
  config: () => ({ id: 'find-sqlite', name: 's', driver: 'sqlite', file: join(dir, 'find.db') }),
  id: 'sqlite',
  scope: {},
  create: [
    'CREATE TABLE find_me (id INTEGER PRIMARY KEY, note TEXT, title VARCHAR(50) NOT NULL, n INTEGER NOT NULL)',
    `INSERT INTO find_me VALUES ${rows(sqlString)}`,
  ],
  drop: ['DROP TABLE IF EXISTS find_me'],
  name: 'find_me',
  reported: (name) => name,
});

describe('Document Database on the seeded PostgreSQL shop', () => {
  it('documents every table, its keys and the views', async () => {
    const db = testDatabase('postgres');
    const session = await postgresDriver.openSession({
      id: 'doc',
      name: 'doc',
      driver: 'postgres',
      host: db.host,
      port: db.port,
      user: db.user,
      password: db.password,
      database: db.database,
    });
    try {
      const scope = { schema: 'public' };
      const snapshot = await readSchemaSnapshot(session.metadata, scope, {
        kinds: postgresDriver.capabilities.objectKinds,
      });
      const text = schemaDocument(snapshot, {
        title: 'public',
        connection: 'pg',
        date: '2026-10-31',
      });
      for (const table of snapshot.tables) {
        expect(text).toContain(`### ${table.name}`);
      }
      expect(text).toContain('### customers');
      expect(text).toContain('**Referenced by**');
      expect(text).toContain('## Views');
      expect(text).toMatch(/→ \[`(public\.)?customers`\]\(#customers\)/u);
    } finally {
      await session.close();
    }
  });
});
