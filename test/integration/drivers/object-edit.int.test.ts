// Editing views, routines and triggers on the real servers, the way "Edit
// Definition…" and "Apply" do it: the definition goes into an editor as a script,
// the edited script replaces the object, and a broken edit leaves the old one alone.

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ObjectRef } from '../../../src/core/model/objects';
import { splitStatements } from '../../../src/core/sql/split';
import type { Driver } from '../../../src/drivers/driver';
import { driver as mysqlDriver } from '../../../src/drivers/mysql';
import { driver as postgresDriver } from '../../../src/drivers/postgres';
import { driver as mssqlDriver } from '../../../src/drivers/mssql';
import { driver as clickhouseDriver } from '../../../src/drivers/clickhouse';
import { createSqliteDriver } from '../../../src/drivers/sqlite';
import { browseSession } from '../../../src/services/browse-session';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { definitionDocument } from '../../../src/services/object-definitions';
import { actionSql, SchemaActions } from '../../../src/services/schema-actions';
import type { ConnectionInput, DriverId } from '../../../src/shared/connection';
import { testDatabase, type TestDatabaseId } from '../../helpers/databases';
import { runAll } from '../../helpers/driver-run';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { buildSqliteWorker, type BuiltWorker } from '../../helpers/sqlite-worker';

interface Editor {
  /** The script "Edit Definition…" would open. */
  open(object: ObjectRef): Promise<string>;
  /** "Apply" with this script: what the user confirms, then runs. */
  apply(object: ObjectRef, script: string): Promise<void>;
  sql(text: string): Promise<unknown[][]>;
  close(): Promise<void>;
}

async function editor(
  drivers: Record<DriverId, Driver>,
  input: ConnectionInput,
  password?: string,
): Promise<Editor> {
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
  const driver = drivers[input.driver];
  const session = async () => await browseSession(manager, connectionId);
  return {
    open: async (object) =>
      definitionDocument(await (await session()).metadata.getDefinition(object), driver.id),
    apply: async (object, script) => {
      const original = await (await session()).metadata.getDefinition(object);
      const statements = splitStatements(script, driver.id).map((s) => s.text);
      const action = { kind: 'replaceObject' as const, object, statements, original };
      await actions.run(connectionId, action, actionSql(action, driver.dialect.ddl));
    },
    sql: async (text) => (await runAll(await session(), text)).rows as unknown[][],
    close: async () => {
      await manager.disconnect(connectionId);
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
    mssql: mssqlDriver,
    clickhouse: clickhouseDriver,
  };
}, 60_000);

afterAll(() => {
  worker.dispose();
});

describe.each(['mysql', 'mariadb'] as const)('editing objects on %s', (serverId) => {
  let e: Editor;
  const db = testDatabase(serverId);
  const object = (kind: ObjectRef['kind'], name: string): ObjectRef => ({
    database: db.database,
    kind,
    name,
  });

  beforeAll(async () => {
    e = await editor(drivers, serverInput(serverId, 'mysql'), db.password);
    for (const sql of [
      'DROP PROCEDURE IF EXISTS edit_proc',
      'DROP VIEW IF EXISTS edit_view',
      'DROP TABLE IF EXISTS edit_log',
      'CREATE TABLE edit_log (id INT AUTO_INCREMENT PRIMARY KEY, what VARCHAR(20))',
      "CREATE PROCEDURE edit_proc() BEGIN SELECT 'one' AS answer; END",
      "CREATE VIEW edit_view AS SELECT 'one' AS answer",
    ]) {
      await e.sql(sql);
    }
    // MySQL with binary logging lets only a privileged user create triggers.
    const root = await mysqlDriver.openSession({
      id: 'edit-root',
      name: 'root',
      driver: 'mysql',
      host: db.host,
      port: db.port,
      user: 'root',
      password: 'datanest_root',
      database: db.database,
    });
    try {
      await runAll(
        root,
        "CREATE TRIGGER edit_trigger BEFORE INSERT ON edit_log FOR EACH ROW SET NEW.what = 'one'",
      );
    } finally {
      await root.close();
    }
  });

  afterAll(async () => {
    await e.sql('DROP PROCEDURE IF EXISTS edit_proc');
    await e.sql('DROP VIEW IF EXISTS edit_view');
    await e.sql('DROP TABLE IF EXISTS edit_log');
    await e.close();
  });

  it('replaces a procedure body through its DELIMITER script', async () => {
    const script = await e.open(object('procedure', 'edit_proc'));
    expect(script).toMatch(/^DELIMITER \/\//);
    await e.apply(object('procedure', 'edit_proc'), script.replace("'one'", "'two'"));
    expect(await e.sql('CALL edit_proc()')).toEqual([['two']]);
  });

  it('leaves the procedure alone when the edit does not compile', async () => {
    const script = await e.open(object('procedure', 'edit_proc'));
    await expect(
      e.apply(object('procedure', 'edit_proc'), script.replace('SELECT', 'SELEC')),
    ).rejects.toMatchObject({ code: 'syntax' });
    expect(await e.sql('CALL edit_proc()')).toEqual([['two']]);
    // The scratch copy that tried the edit out is gone too.
    const scratch = await e.sql(
      `SELECT COUNT(*) FROM information_schema.ROUTINES WHERE ROUTINE_SCHEMA = DATABASE() AND ROUTINE_NAME LIKE 'edit_proc%'`,
    );
    expect(scratch).toEqual([[1]]);
  });

  it('replaces a view in one step', async () => {
    const script = await e.open(object('view', 'edit_view'));
    await e.apply(object('view', 'edit_view'), script.replace("'one'", "'two'"));
    expect(await e.sql('SELECT answer FROM edit_view')).toEqual([['two']]);
  });

  it('refuses to replace a trigger it may not create, before dropping anything', async () => {
    const trigger = { ...object('trigger', 'edit_trigger'), table: 'edit_log' };
    const script = await e.open(trigger);
    // The trigger belongs to root (DEFINER=root); this user may not create it again.
    // The scratch copy fails first, so the real trigger is never dropped.
    await expect(e.apply(trigger, script.replace("'one'", "'two'"))).rejects.toMatchObject({
      code: 'permission-denied',
    });
    await e.sql('INSERT INTO edit_log () VALUES ()');
    expect(await e.sql('SELECT what FROM edit_log')).toEqual([['one']]);
  });

  it('replaces a trigger once the DEFINER is the user itself', async () => {
    const trigger = { ...object('trigger', 'edit_trigger'), table: 'edit_log' };
    const script = (await e.open(trigger)).replace(/DEFINER=\S+\s+/, '');
    if (serverId === 'mysql') {
      // MySQL with binary logging still wants SUPER for any trigger.
      await expect(e.apply(trigger, script)).rejects.toMatchObject({ code: 'permission-denied' });
      return;
    }
    await e.apply(trigger, script.replace("'one'", "'two'"));
    await e.sql('DELETE FROM edit_log');
    await e.sql('INSERT INTO edit_log () VALUES ()');
    expect(await e.sql('SELECT what FROM edit_log')).toEqual([['two']]);
  });
});

describe('editing objects on postgres', () => {
  let e: Editor;
  const db = testDatabase('postgres');

  beforeAll(async () => {
    e = await editor(drivers, serverInput('postgres', 'postgres'), db.password);
    for (const sql of [
      'DROP MATERIALIZED VIEW IF EXISTS edit_mv',
      'DROP VIEW IF EXISTS edit_view',
      'DROP TABLE IF EXISTS edit_log',
      'DROP FUNCTION IF EXISTS edit_fn()',
      'DROP FUNCTION IF EXISTS edit_touch()',
      "CREATE FUNCTION edit_fn() RETURNS text LANGUAGE sql AS $$ SELECT 'one' $$",
      "CREATE VIEW edit_view AS SELECT 'one'::text AS answer",
      "CREATE MATERIALIZED VIEW edit_mv AS SELECT 'one'::text AS answer",
      'CREATE INDEX edit_mv_answer ON edit_mv (answer)',
      'CREATE TABLE edit_log (id serial PRIMARY KEY, what text)',
      `CREATE FUNCTION edit_touch() RETURNS trigger LANGUAGE plpgsql AS $$
       BEGIN NEW.what := 'one'; RETURN NEW; END $$`,
      'CREATE TRIGGER edit_trigger BEFORE INSERT ON edit_log FOR EACH ROW EXECUTE FUNCTION edit_touch()',
    ]) {
      await e.sql(sql);
    }
  });

  afterAll(async () => {
    await e.sql('DROP MATERIALIZED VIEW IF EXISTS edit_mv');
    await e.sql('DROP VIEW IF EXISTS edit_view');
    await e.sql('DROP TABLE IF EXISTS edit_log');
    await e.sql('DROP FUNCTION IF EXISTS edit_fn()');
    await e.sql('DROP FUNCTION IF EXISTS edit_touch()');
    await e.close();
  });

  it('replaces a function, and rolls a broken edit back', async () => {
    const fn: ObjectRef = { kind: 'function', name: 'edit_fn', signature: '' };
    const script = await e.open(fn);
    await e.apply(fn, script.replace("'one'", "'two'"));
    expect(await e.sql('SELECT edit_fn()')).toEqual([['two']]);
    await expect(e.apply(fn, script.replace('SELECT', 'SELEC'))).rejects.toMatchObject({
      code: 'syntax',
    });
    expect(await e.sql('SELECT edit_fn()')).toEqual([['two']]);
  });

  it('replaces a view and a materialized view, keeping its index', async () => {
    const view: ObjectRef = { kind: 'view', name: 'edit_view' };
    await e.apply(view, (await e.open(view)).replace("'one'", "'two'"));
    expect(await e.sql('SELECT answer FROM edit_view')).toEqual([['two']]);
    const mv: ObjectRef = { kind: 'view', name: 'edit_mv', materialized: true };
    await e.apply(mv, (await e.open(mv)).replace("'one'", "'two'"));
    expect(await e.sql('SELECT answer FROM edit_mv')).toEqual([['two']]);
    expect(await e.sql("SELECT 1 FROM pg_indexes WHERE indexname = 'edit_mv_answer'")).toEqual([
      [1],
    ]);
  });

  it('replaces a trigger on its table', async () => {
    const trigger: ObjectRef = { kind: 'trigger', name: 'edit_trigger', table: 'edit_log' };
    const script = await e.open(trigger);
    await e.apply(trigger, script.replace('BEFORE INSERT', 'BEFORE INSERT OR UPDATE'));
    const [definition] = await (async () =>
      (await e.sql(
        "SELECT pg_get_triggerdef(oid) FROM pg_trigger WHERE tgname = 'edit_trigger'",
      )) as string[][])();
    expect(definition?.[0]).toContain('BEFORE INSERT OR UPDATE');
  });
});

describe('editing objects on sqlite', () => {
  let e: Editor;
  let dir: string;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'datanest-edit-'));
    e = await editor(drivers, {
      name: 'sqlite',
      driver: 'sqlite',
      file: join(dir, 'edit.db'),
    });
    for (const sql of [
      'CREATE TABLE log (id INTEGER PRIMARY KEY, what TEXT)',
      "CREATE VIEW answers AS SELECT 'one' AS answer",
      "CREATE TRIGGER log_what AFTER INSERT ON log BEGIN UPDATE log SET what = 'one' WHERE id = NEW.id; END",
    ]) {
      await e.sql(sql);
    }
  });

  afterAll(async () => {
    await e.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('replaces a view, and keeps it when the edit is broken', async () => {
    const view: ObjectRef = { kind: 'view', name: 'answers' };
    const script = await e.open(view);
    await e.apply(view, script.replace("'one'", "'two'"));
    expect(await e.sql('SELECT answer FROM answers')).toEqual([['two']]);
    await expect(e.apply(view, script.replace('SELECT', 'SELEC'))).rejects.toMatchObject({
      code: 'syntax',
    });
    expect(await e.sql('SELECT answer FROM answers')).toEqual([['two']]);
  });

  it('replaces a trigger with a body of several words', async () => {
    const trigger: ObjectRef = { kind: 'trigger', name: 'log_what' };
    await e.apply(trigger, (await e.open(trigger)).replace("'one'", "'two'"));
    await e.sql('INSERT INTO log (id) VALUES (1)');
    expect(await e.sql('SELECT what FROM log')).toEqual([['two']]);
  });
});
