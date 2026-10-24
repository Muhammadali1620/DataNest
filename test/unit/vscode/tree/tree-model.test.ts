import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { ConnectionManager } from '../../../../src/services/connection-manager';
import { ConnectionStore } from '../../../../src/services/connection-store';
import { MetadataCache } from '../../../../src/services/metadata-cache';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import { TreeModel, type TreeTexts } from '../../../../src/vscode/tree/tree-model';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeDriverProvider, linkLostError } from '../../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../../helpers/fakes';

const TEXTS: TreeTexts = {
  tables: 'Tables',
  views: 'Views',
  noTables: 'No tables',
  noViews: 'No views',
  noDatabases: 'No databases',
  noColumns: 'No columns',
};

describe('TreeModel', () => {
  let store: ConnectionStore;
  let drivers: FakeDriverProvider;
  let manager: ConnectionManager;
  let cache: MetadataCache;
  let showSystemObjects: boolean;
  let logger: RecordingLogger;
  let model: TreeModel;
  let mysql: ConnectionConfig;

  beforeEach(async () => {
    logger = new RecordingLogger();
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    drivers = new FakeDriverProvider();
    manager = new ConnectionManager({ store, drivers, logger });
    cache = new MetadataCache({ logger });
    showSystemObjects = false;
    model = new TreeModel({
      store,
      manager,
      cache,
      settings: { showSystemObjects: () => showSystemObjects },
      logger,
      texts: TEXTS,
    });
    mysql = await store.add({ name: 'Local', driver: 'mysql', host: 'h' });
  });

  describe('roots', () => {
    it('lists saved connections in order', async () => {
      await store.add({ name: 'Second', driver: 'sqlite', file: '/db' });
      expect(model.roots()).toEqual([
        { kind: 'connection', connectionId: mysql.id },
        { kind: 'connection', connectionId: store.list()[1]?.id },
      ]);
    });

    it('is empty when nothing is saved', async () => {
      await store.remove(mysql.id);
      expect(model.roots()).toEqual([]);
    });
  });

  describe('children of a connection', () => {
    it('lists databases for a server that has them', async () => {
      drivers.driver('mysql').sessionMetadata.databases = ['app', 'shop'];
      expect(await model.children({ kind: 'connection', connectionId: mysql.id })).toEqual([
        { kind: 'database', connectionId: mysql.id, database: 'app' },
        { kind: 'database', connectionId: mysql.id, database: 'shop' },
      ]);
    });

    it('connects on expansion', async () => {
      await model.children({ kind: 'connection', connectionId: mysql.id });
      expect(manager.getState(mysql.id).status).toBe('connected');
    });

    it('says so when the server reports no databases', async () => {
      drivers.driver('mysql').sessionMetadata.databases = [];
      expect(await model.children({ kind: 'connection', connectionId: mysql.id })).toEqual([
        { kind: 'message', text: 'No databases', connectionId: mysql.id },
      ]);
    });

    it('goes straight to groups for a single-file database', async () => {
      const sqlite = await store.add({ name: 'File', driver: 'sqlite', file: '/db' });
      drivers.driver('sqlite').capabilities = {
        databases: false,
        schemas: false,
        databaseScopedSessions: false,
        cancel: true,
      };
      expect(await model.children({ kind: 'connection', connectionId: sqlite.id })).toEqual([
        { kind: 'group', group: 'tables', connectionId: sqlite.id, scope: {} },
        { kind: 'group', group: 'views', connectionId: sqlite.id, scope: {} },
      ]);
    });

    it("hides the server's own databases by default", async () => {
      drivers.driver('mysql').sessionMetadata.databases = [
        'app',
        'information_schema',
        'mysql',
        'shop',
      ];
      const children = await model.children({ kind: 'connection', connectionId: mysql.id });
      expect(children).toEqual([
        { kind: 'database', connectionId: mysql.id, database: 'app' },
        { kind: 'database', connectionId: mysql.id, database: 'shop' },
      ]);
    });

    it('shows them when the setting is on, without asking the server again', async () => {
      const driver = drivers.driver('mysql');
      driver.sessionMetadata.databases = ['app', 'information_schema'];
      await model.children({ kind: 'connection', connectionId: mysql.id });
      showSystemObjects = true;
      const children = await model.children({ kind: 'connection', connectionId: mysql.id });
      expect(children.map((node) => (node.kind === 'database' ? node.database : ''))).toEqual([
        'app',
        'information_schema',
      ]);
      // The list came from the cache: filtering is local to the tree.
      expect(driver.lastSession?.metadata.calls.filter((c) => c === 'listDatabases')).toHaveLength(
        1,
      );
    });

    it('says there are no databases when only system ones exist', async () => {
      drivers.driver('mysql').sessionMetadata.databases = ['mysql', 'sys'];
      expect(await model.children({ kind: 'connection', connectionId: mysql.id })).toEqual([
        { kind: 'message', text: 'No databases', connectionId: mysql.id },
      ]);
    });

    it('shows the failure as a leaf instead of breaking the tree', async () => {
      drivers.driver('mysql').openError = new DbError('auth-failed', 'Access denied');
      const children = await model.children({ kind: 'connection', connectionId: mysql.id });
      expect(children).toEqual([
        { kind: 'message', text: 'Access denied', failed: true, connectionId: mysql.id },
      ]);
      expect(logger.messages('warn').some((m) => m.includes('connection'))).toBe(true);
    });
  });

  describe('children of a database', () => {
    it('lists groups when the driver has no schemas', async () => {
      expect(
        await model.children({ kind: 'database', connectionId: mysql.id, database: 'app' }),
      ).toEqual([
        { kind: 'group', group: 'tables', connectionId: mysql.id, scope: { database: 'app' } },
        { kind: 'group', group: 'views', connectionId: mysql.id, scope: { database: 'app' } },
      ]);
    });

    it('hides system schemas by default and shows them when asked', async () => {
      const pg = await store.add({ name: 'PG2', driver: 'postgres', host: 'h' });
      const driver = drivers.driver('postgres');
      driver.capabilities = {
        databases: true,
        schemas: true,
        databaseScopedSessions: true,
        cancel: true,
      };
      driver.sessionMetadata.schemas = ['public', 'pg_catalog', 'information_schema', 'audit'];
      const hidden = await model.children({
        kind: 'database',
        connectionId: pg.id,
        database: 'app',
      });
      expect(hidden.map((node) => (node.kind === 'schema' ? node.schema : ''))).toEqual([
        'public',
        'audit',
      ]);
      showSystemObjects = true;
      const shown = await model.children({
        kind: 'database',
        connectionId: pg.id,
        database: 'app',
      });
      expect(shown).toHaveLength(4);
    });

    it('lists schemas when the driver has them', async () => {
      const pg = await store.add({ name: 'PG', driver: 'postgres', host: 'h' });
      const driver = drivers.driver('postgres');
      driver.capabilities = {
        databases: true,
        schemas: true,
        databaseScopedSessions: true,
        cancel: true,
      };
      driver.sessionMetadata.schemas = ['public', 'audit'];
      expect(
        await model.children({ kind: 'database', connectionId: pg.id, database: 'app' }),
      ).toEqual([
        { kind: 'schema', connectionId: pg.id, database: 'app', schema: 'public' },
        { kind: 'schema', connectionId: pg.id, database: 'app', schema: 'audit' },
      ]);
    });
  });

  describe('sessions while browsing', () => {
    it('reuses one session across databases when the driver can look across them', async () => {
      const driver = drivers.driver('mysql');
      driver.sessionMetadata.databases = ['app', 'shop'];
      await model.children({ kind: 'connection', connectionId: mysql.id });
      await model.children({
        kind: 'group',
        group: 'tables',
        connectionId: mysql.id,
        scope: { database: 'app' },
      });
      await model.children({
        kind: 'group',
        group: 'tables',
        connectionId: mysql.id,
        scope: { database: 'shop' },
      });
      expect(driver.sessions).toHaveLength(1);
    });

    it('keeps one session per database when a session cannot leave its own', async () => {
      const pg = await store.add({ name: 'PG', driver: 'postgres', host: 'h' });
      const driver = drivers.driver('postgres');
      driver.capabilities = {
        databases: true,
        schemas: true,
        databaseScopedSessions: true,
        cancel: true,
      };
      await model.children({
        kind: 'group',
        group: 'tables',
        connectionId: pg.id,
        scope: { database: 'app' },
      });
      await model.children({
        kind: 'group',
        group: 'tables',
        connectionId: pg.id,
        scope: { database: 'shop' },
      });
      await model.children({
        kind: 'group',
        group: 'tables',
        connectionId: pg.id,
        scope: { database: 'app' },
      });
      // One per database, and revisiting a database does not reconnect.
      expect(driver.sessions).toHaveLength(2);
      expect(driver.opened.map((config) => config.database)).toEqual(['app', 'shop']);
    });
  });

  describe('children of a group', () => {
    const group = (scope = {}): TreeNode => ({
      kind: 'group',
      group: 'tables',
      connectionId: mysql.id,
      scope,
    });

    it('lists only tables in the Tables group', async () => {
      drivers.driver('mysql').sessionMetadata.tables = [
        { name: 'orders', kind: 'table' },
        { name: 'order_totals', kind: 'view' },
      ];
      expect(await model.children(group())).toEqual([
        {
          kind: 'table',
          connectionId: mysql.id,
          scope: {},
          name: 'orders',
          tableKind: 'table',
        },
      ]);
    });

    it('lists only views in the Views group', async () => {
      drivers.driver('mysql').sessionMetadata.tables = [
        { name: 'orders', kind: 'table' },
        { name: 'order_totals', kind: 'view' },
      ];
      expect(
        await model.children({
          kind: 'group',
          group: 'views',
          connectionId: mysql.id,
          scope: {},
        }),
      ).toEqual([
        {
          kind: 'table',
          connectionId: mysql.id,
          scope: {},
          name: 'order_totals',
          tableKind: 'view',
        },
      ]);
    });

    it('asks the server for the right scope', async () => {
      const driver = drivers.driver('mysql');
      await model.children(group({ database: 'app', schema: 'public' }));
      expect(driver.lastSession?.metadata.calls).toContain('listTables:app/public');
    });

    it('says when a group is empty', async () => {
      drivers.driver('mysql').sessionMetadata.tables = [];
      expect(await model.children(group())).toEqual([
        { kind: 'message', text: 'No tables', connectionId: mysql.id },
      ]);
      expect(
        await model.children({ kind: 'group', group: 'views', connectionId: mysql.id, scope: {} }),
      ).toEqual([{ kind: 'message', text: 'No views', connectionId: mysql.id }]);
    });

    it('reports a lost link as a leaf', async () => {
      drivers.driver('mysql').metadataError = linkLostError('Connection lost');
      expect(await model.children(group())).toEqual([
        { kind: 'message', text: 'Connection lost', failed: true, connectionId: mysql.id },
      ]);
    });
  });

  describe('children of a table', () => {
    const table: TreeNode = {
      kind: 'table',
      connectionId: '',
      scope: { database: 'app' },
      name: 'orders',
      tableKind: 'table',
    };

    it('lists columns with their details', async () => {
      drivers.driver('mysql').sessionMetadata.columns = [
        { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
        { name: 'note', dataType: 'text', nullable: true, primaryKey: false },
      ];
      const children = await model.children({ ...table, connectionId: mysql.id });
      expect(children).toEqual([
        {
          kind: 'column',
          connectionId: mysql.id,
          table: { database: 'app', name: 'orders' },
          column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
        },
        {
          kind: 'column',
          connectionId: mysql.id,
          table: { database: 'app', name: 'orders' },
          column: { name: 'note', dataType: 'text', nullable: true, primaryKey: false },
        },
      ]);
    });

    it('says when a table has no columns', async () => {
      drivers.driver('mysql').sessionMetadata.columns = [];
      expect(await model.children({ ...table, connectionId: mysql.id })).toEqual([
        { kind: 'message', text: 'No columns', connectionId: mysql.id },
      ]);
    });
  });

  describe('leaves', () => {
    it('columns and messages have no children', async () => {
      expect(
        await model.children({
          kind: 'column',
          connectionId: mysql.id,
          table: { name: 't' },
          column: { name: 'id', dataType: 'int', nullable: false, primaryKey: true },
        }),
      ).toEqual([]);
      expect(await model.children({ kind: 'message', text: 'anything' })).toEqual([]);
    });
  });

  describe('unknown connection', () => {
    it('reports it as a leaf instead of throwing', async () => {
      const children = await model.children({ kind: 'connection', connectionId: 'missing' });
      expect(children[0]).toMatchObject({ kind: 'message', failed: true });
    });
  });
});
