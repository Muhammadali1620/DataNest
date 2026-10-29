import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../src/core/errors';
import { splitStatements } from '../../../src/core/sql/split';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import {
  definitionDocument,
  readDefinitionDocument,
} from '../../../src/services/object-definitions';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

const ROUTINE = `CREATE PROCEDURE p()
BEGIN
  SELECT 1;
  SELECT 2;
END`;

describe('definitionDocument: SQL Server (V6.2)', () => {
  it('ends every statement with GO, so a routine starts its own batch', () => {
    const document = definitionDocument(
      ['CREATE TABLE [t] (a INT)', 'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\nEND;', ' '],
      'mssql',
    );
    expect(document).toBe(
      'CREATE TABLE [t] (a INT)\nGO\n\nCREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\nEND;\nGO\n',
    );
    expect(splitStatements(document, 'mssql').map((s) => s.text)).toEqual([
      'CREATE TABLE [t] (a INT)',
      'CREATE PROCEDURE p AS\nBEGIN\n  SELECT 1;\nEND;',
    ]);
  });

  it('is empty without statements', () => {
    expect(definitionDocument([], 'mssql')).toBe('');
  });
});

describe('definitionDocument', () => {
  it('ends every statement with a semicolon and separates them by a blank line', () => {
    expect(
      definitionDocument(['CREATE TABLE t (id int)', 'CREATE INDEX i ON t (id)'], 'postgres'),
    ).toBe('CREATE TABLE t (id int);\n\nCREATE INDEX i ON t (id);\n');
  });

  it('trims statements and skips empty ones', () => {
    expect(definitionDocument(['  CREATE VIEW v AS SELECT 1 \n', '', '   '], 'sqlite')).toBe(
      'CREATE VIEW v AS SELECT 1;\n',
    );
  });

  it('is empty when there is nothing to show', () => {
    expect(definitionDocument([], 'mysql')).toBe('');
  });

  it('switches the delimiter around a MySQL body with semicolons', () => {
    const text = definitionDocument([ROUTINE], 'mysql');
    expect(text).toBe(`DELIMITER //\n\n${ROUTINE}//\n\nDELIMITER ;\n`);
    // The script runs back as exactly one statement.
    expect(splitStatements(text, 'mysql').map((statement) => statement.text)).toEqual([ROUTINE]);
  });

  it('keeps a body with // in strings and comments as one statement', () => {
    const body =
      "CREATE TRIGGER t BEFORE INSERT ON x FOR EACH ROW\nBEGIN\n  -- see //docs\n  SET NEW.u = 'http://a';\n  SET NEW.v = 1;\nEND";
    const text = definitionDocument([body, 'CREATE TABLE y (id int)'], 'mysql');
    expect(splitStatements(text, 'mysql').map((statement) => statement.text)).toEqual([
      body,
      'CREATE TABLE y (id int)',
    ]);
  });

  it('keeps plain MySQL statements without a delimiter switch', () => {
    expect(definitionDocument(['CREATE TABLE `t` (`id` int)'], 'mysql')).toBe(
      'CREATE TABLE `t` (`id` int);\n',
    );
  });

  it('does not take a semicolon inside a string for a body', () => {
    expect(definitionDocument(["CREATE VIEW v AS SELECT 'a;b' AS x"], 'mysql')).toBe(
      "CREATE VIEW v AS SELECT 'a;b' AS x;\n",
    );
  });

  it('never needs a delimiter switch in PostgreSQL: dollar quotes hold the body', () => {
    const fn = 'CREATE FUNCTION f() RETURNS int LANGUAGE sql AS $$ SELECT 1; $$';
    const text = definitionDocument([fn], 'postgres');
    expect(text).toBe(`${fn};\n`);
    expect(splitStatements(text, 'postgres').map((statement) => statement.text)).toEqual([fn]);
  });
});

describe('readDefinitionDocument', () => {
  let store: ConnectionStore;
  let drivers: FakeDriverProvider;
  let manager: ConnectionManager;

  beforeEach(() => {
    const logger = new RecordingLogger();
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    drivers = new FakeDriverProvider();
    manager = new ConnectionManager({ store, drivers, logger });
  });

  it('reads on the browsing session and renders the script', async () => {
    const config = await store.add({ name: 'Local', driver: 'mysql', host: 'h' });
    drivers.driver('mysql').sessionMetadata.definitions.set('table:orders', ['CREATE TABLE o']);
    const text = await readDefinitionDocument(manager, config.id, {
      database: 'shop',
      kind: 'table',
      name: 'orders',
    });
    expect(text).toBe('CREATE TABLE o;\n');
    // MySQL sees every database from one session: the tree's session is reused.
    expect(manager.sessionOf(ConnectionManager.treeOwner(config.id))).toBeDefined();
  });

  it('uses a session of the object database where sessions are database-scoped', async () => {
    const config = await store.add({ name: 'PG', driver: 'postgres', host: 'h' });
    const driver = drivers.driver('postgres');
    driver.capabilities = { ...driver.capabilities, schemas: true, databaseScopedSessions: true };
    driver.sessionMetadata.definitions.set('view:v', ['CREATE VIEW v AS SELECT 1']);
    await readDefinitionDocument(manager, config.id, {
      database: 'shop',
      schema: 'public',
      kind: 'view',
      name: 'v',
    });
    expect(manager.sessionOf(ConnectionManager.treeOwner(config.id, 'shop'))).toBeDefined();
    expect(driver.opened.at(-1)?.database).toBe('shop');
  });

  it('passes a missing object through as not-found', async () => {
    const config = await store.add({ name: 'Local', driver: 'sqlite', file: '/db' });
    await expect(
      readDefinitionDocument(manager, config.id, { kind: 'table', name: 'gone' }),
    ).rejects.toBeInstanceOf(DbError);
    await expect(
      readDefinitionDocument(manager, config.id, { kind: 'table', name: 'gone' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  it('fails for a connection that does not exist', async () => {
    await expect(
      readDefinitionDocument(manager, 'missing', { kind: 'table', name: 't' }),
    ).rejects.toMatchObject({ code: 'not-found' });
  });
});
