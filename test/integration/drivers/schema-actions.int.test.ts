// Creating, renaming, emptying and dropping structure on the real servers, through
// the same SchemaActions the tree commands use.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { browseSession } from '../../../src/services/browse-session';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { SchemaActions, type SchemaAction } from '../../../src/services/schema-actions';
import type { ConnectionInput, DriverId } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

interface Harness {
  readonly manager: ConnectionManager;
  readonly actions: SchemaActions;
  readonly connectionId: string;
  /** Builds the SQL the user would see, then runs exactly that. */
  perform(action: SchemaAction): Promise<string>;
  /** Runs SQL on the browsing session of a database. */
  sql(text: string, database?: string): Promise<unknown[][]>;
}

async function harness(
  drivers: Record<DriverId, Driver>,
  input: ConnectionInput,
  password?: string,
): Promise<Harness> {
  const logger = new RecordingLogger();
  const store = new ConnectionStore({
    state: new FakeMemento(),
    secrets: new FakeSecretStorage(),
    logger,
  });
  const manager = new ConnectionManager({
    store,
    drivers: { get: (id) => Promise.resolve(drivers[id]) },
    logger,
  });
  const actions = new SchemaActions({ manager, cache: new MetadataCache({ logger }), logger });
  const connectionId = (await store.add(input, password)).id;
  return {
    manager,
    actions,
    connectionId,
    perform: async (action) => {
      const sql = await actions.sqlOf(connectionId, action);
      await actions.run(connectionId, action, sql);
      return sql;
    },
    sql: async (text, database) => {
      const session = await browseSession(manager, connectionId, database);
      return (await runAll(session, text)).rows as unknown[][];
    },
  };
}

function serverInput(id: TestDatabaseId, driver: DriverId): ConnectionInput {
  const db = testDatabase(id);
  return {
    name: id,
    driver,
    host: db.host,
    port: db.port,
    user: db.user,
    database: db.database,
  };
}

let worker: BuiltWorker;
let drivers: Record<DriverId, Driver>;

beforeAll(async () => {
  worker = await buildSqliteWorker();
  drivers = {
    mysql: mysqlDriver,
    postgres: postgresDriver,
    sqlite: createSqliteDriver({ workerPath: worker.workerPath }),
  };
}, 60_000);

afterAll(() => {
  worker.dispose();
});

describe.each(['mysql', 'mariadb'] as const)('schema actions on %s', (serverId) => {
  let h: Harness;
  const db = testDatabase(serverId);
  const table = (name: string) => ({ database: db.database, name });

  beforeAll(async () => {
    h = await harness(drivers, serverInput(serverId, 'mysql'), db.password);
    for (const name of ['act_new', 'act_renamed', 'act_view', 'act_view2']) {
      await h.sql(`DROP VIEW IF EXISTS ${name}`);
      await h.sql(`DROP TABLE IF EXISTS ${name}`);
    }
    await h.sql('DROP PROCEDURE IF EXISTS act_proc');
  });

  afterAll(async () => {
    await h.sql('DROP VIEW IF EXISTS act_view2');
    await h.sql('DROP TABLE IF EXISTS act_renamed');
    await h.sql('DROP PROCEDURE IF EXISTS act_proc');
    // The drop-and-create test must never leave the empty database missing.
    await h.sql(`CREATE DATABASE IF NOT EXISTS ${db.emptyDatabase}`);
    await h.manager.disconnect(h.connectionId);
  });

  it('creates a table with an auto-increment key', async () => {
    await h.perform({ kind: 'createTable', table: table('act_new') });
    await h.sql('INSERT INTO act_new () VALUES (), ()');
    expect(await h.sql('SELECT id FROM act_new ORDER BY id')).toEqual([[1], [2]]);
  });

  it('renames a table, empties it and keeps it', async () => {
    await h.perform({
      kind: 'renameTable',
      table: table('act_new'),
      relation: 'table',
      newName: 'act_renamed',
    });
    await h.perform({ kind: 'truncateTable', table: table('act_renamed') });
    expect(await h.sql('SELECT COUNT(*) FROM act_renamed')).toEqual([[0]]);
  });

  it('renames and drops a view', async () => {
    await h.sql('CREATE VIEW act_view AS SELECT 1 AS one');
    await h.perform({
      kind: 'renameTable',
      table: table('act_view'),
      relation: 'view',
      newName: 'act_view2',
    });
    expect(await h.sql('SELECT one FROM act_view2')).toEqual([[1]]);
    await h.perform({ kind: 'dropTable', table: table('act_view2'), relation: 'view' });
    await expect(h.sql('SELECT one FROM act_view2')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('drops a procedure', async () => {
    await h.sql('CREATE PROCEDURE act_proc() SELECT 1');
    await h.perform({
      kind: 'dropObject',
      object: { database: db.database, kind: 'procedure', name: 'act_proc' },
    });
    await expect(h.sql('CALL act_proc()')).rejects.toMatchObject({ code: 'not-found' });
  });

  it('drops and creates a database the user may manage', async () => {
    await h.perform({ kind: 'dropDatabase', name: db.emptyDatabase });
    let names = await h.sql('SHOW DATABASES');
    expect(names.flat()).not.toContain(db.emptyDatabase);
    await h.perform({ kind: 'createDatabase', name: db.emptyDatabase });
    names = await h.sql('SHOW DATABASES');
    expect(names.flat()).toContain(db.emptyDatabase);
  });

  it('reports a database the user may not create as permission-denied', async () => {
    await expect(
      h.perform({ kind: 'createDatabase', name: 'act_not_allowed' }),
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('refuses a table that already exists, with the server message', async () => {
    await expect(h.perform({ kind: 'createTable', table: table('act_renamed') })).rejects.toThrow(
      /already exists/,
    );
  });
});

describe('schema actions on postgres', () => {
  let h: Harness;
  const db = testDatabase('postgres');

  beforeAll(async () => {
    h = await harness(drivers, serverInput('postgres', 'postgres'), db.password);
    await h.sql('DROP DATABASE IF EXISTS act_db');
    await h.sql('DROP SCHEMA IF EXISTS act_schema CASCADE');
    await h.sql('DROP MATERIALIZED VIEW IF EXISTS act_mv, act_mv2');
    await h.sql('DROP TABLE IF EXISTS act_new, act_renamed CASCADE');
  });

  afterAll(async () => {
    await h.sql('DROP SCHEMA IF EXISTS act_schema CASCADE');
    await h.sql('DROP MATERIALIZED VIEW IF EXISTS act_mv, act_mv2');
    await h.sql('DROP TABLE IF EXISTS act_new, act_renamed CASCADE');
    await h.manager.disconnect(h.connectionId);
    const cleanup = await harness(drivers, serverInput('postgres', 'postgres'), db.password);
    await cleanup.sql('DROP DATABASE IF EXISTS act_db');
    await cleanup.manager.disconnect(cleanup.connectionId);
  });

  it('creates a database, browses into it, and drops it again', async () => {
    await h.perform({ kind: 'createDatabase', name: 'act_db' });
    // The tree opens a session inside the new database, as a user expanding it would.
    await browseSession(h.manager, h.connectionId, 'act_db');
    await h.perform({ kind: 'dropDatabase', name: 'act_db' });
    expect(await h.sql("SELECT 1 FROM pg_database WHERE datname = 'act_db'")).toEqual([]);
  });

  it('creates a schema, a table in it, and drops the schema with CASCADE', async () => {
    await h.perform({ kind: 'createSchema', database: db.database, name: 'act_schema' });
    await h.perform({
      kind: 'createTable',
      table: { database: db.database, schema: 'act_schema', name: 'inside' },
    });
    await expect(
      h.perform({ kind: 'dropSchema', database: db.database, name: 'act_schema', cascade: false }),
    ).rejects.toMatchObject({ message: expect.stringContaining('depend') as unknown });
    await h.perform({
      kind: 'dropSchema',
      database: db.database,
      name: 'act_schema',
      cascade: true,
    });
    expect(await h.sql("SELECT 1 FROM pg_namespace WHERE nspname = 'act_schema'")).toEqual([]);
  });

  it('creates a table with an identity key, renames and empties it', async () => {
    const ref = { database: db.database, schema: 'public', name: 'act_new' };
    await h.perform({ kind: 'createTable', table: ref });
    await h.sql('INSERT INTO act_new DEFAULT VALUES');
    await h.perform({ kind: 'renameTable', table: ref, relation: 'table', newName: 'act_renamed' });
    const renamed = { ...ref, name: 'act_renamed' };
    expect(await h.sql('SELECT id FROM act_renamed')).toEqual([[1]]);
    await h.perform({ kind: 'truncateTable', table: renamed });
    expect(await h.sql('SELECT COUNT(*)::int FROM act_renamed')).toEqual([[0]]);
    await h.perform({ kind: 'dropTable', table: renamed, relation: 'table' });
  });

  it('renames and drops a materialized view with its own words', async () => {
    await h.sql('CREATE MATERIALIZED VIEW act_mv AS SELECT 1 AS one');
    const ref = { schema: 'public', name: 'act_mv' };
    await h.perform({
      kind: 'renameTable',
      table: ref,
      relation: 'materialized-view',
      newName: 'act_mv2',
    });
    await h.perform({
      kind: 'dropTable',
      table: { ...ref, name: 'act_mv2' },
      relation: 'materialized-view',
    });
    expect(await h.sql("SELECT 1 FROM pg_class WHERE relname LIKE 'act_mv%'")).toEqual([]);
  });

  it('drops an overloaded function by its signature only', async () => {
    await h.sql('CREATE FUNCTION act_fn(a integer) RETURNS integer LANGUAGE sql AS $$ SELECT a $$');
    await h.sql('CREATE FUNCTION act_fn(a text) RETURNS text LANGUAGE sql AS $$ SELECT a $$');
    const before = await h.manager
      .acquire(ConnectionManager.treeOwner(h.connectionId, db.database), {
        connectionId: h.connectionId,
        database: db.database,
      })
      .then(
        async (session) => await session.metadata.listObjects({ schema: 'public' }, 'function'),
      );
    const integer = before.find((f) => f.name === 'act_fn' && f.signature === 'a integer');
    expect(integer).toBeDefined();
    await h.perform({
      kind: 'dropObject',
      object: { schema: 'public', kind: 'function', name: 'act_fn', signature: 'a integer' },
    });
    expect(await h.sql("SELECT act_fn('still here')")).toEqual([['still here']]);
    await h.perform({
      kind: 'dropObject',
      object: { schema: 'public', kind: 'function', name: 'act_fn', signature: 'a text' },
    });
  });
});

describe('schema actions on sqlite', () => {
  let h: Harness;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'datanest-actions-'));
    h = await harness(drivers, {
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'actions.db'),
    });
  });

  afterAll(async () => {
    await h.manager.disconnect(h.connectionId);
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates, renames, empties and drops a table', async () => {
    await h.perform({ kind: 'createTable', table: { name: 'notes' } });
    await h.sql('INSERT INTO notes DEFAULT VALUES');
    await h.perform({
      kind: 'renameTable',
      table: { name: 'notes' },
      relation: 'table',
      newName: 'memos',
    });
    expect(await h.sql('SELECT id FROM memos')).toEqual([[1]]);
    await h.perform({ kind: 'truncateTable', table: { name: 'memos' } });
    expect(await h.sql('SELECT COUNT(*) FROM memos')).toEqual([[0]]);
    await h.sql('CREATE TRIGGER memos_t AFTER INSERT ON memos BEGIN SELECT 1; END');
    await h.perform({ kind: 'dropObject', object: { kind: 'trigger', name: 'memos_t' } });
    await h.perform({ kind: 'dropTable', table: { name: 'memos' }, relation: 'table' });
    expect(await h.sql("SELECT name FROM sqlite_master WHERE name LIKE 'memos%'")).toEqual([]);
  });

  it('cannot rename a view or create a database', async () => {
    await h.sql('CREATE VIEW v AS SELECT 1');
    await expect(
      h.actions.sqlOf(h.connectionId, {
        kind: 'renameTable',
        table: { name: 'v' },
        relation: 'view',
        newName: 'w',
      }),
    ).rejects.toMatchObject({ code: 'unsupported' });
    await expect(
      h.actions.sqlOf(h.connectionId, { kind: 'createDatabase', name: 'x' }),
    ).rejects.toMatchObject({ code: 'unsupported' });
  });
});
