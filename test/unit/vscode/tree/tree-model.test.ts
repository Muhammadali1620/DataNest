import { beforeEach, describe, expect, it } from 'vitest';
import { DbError } from '../../../../src/core/errors';
import { ConnectionManager } from '../../../../src/services/connection-manager';
import { ConnectionStore } from '../../../../src/services/connection-store';
import { MetadataCache } from '../../../../src/services/metadata-cache';
import type { ConnectionConfig } from '../../../../src/shared/connection';
import { TreeModel, type TreeTexts } from '../../../../src/vscode/tree/tree-model';
import {
  type ProjectFolder,
  ProjectConnections,
  projectConnectionId,
} from '../../../../src/services/project-connections';
import type { TreeNode } from '../../../../src/vscode/tree/nodes';
import { FakeDriverProvider, linkLostError } from '../../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../../helpers/fakes';

const TEXTS: TreeTexts = {
  emptyFolder: 'Drag here',
  tables: 'Tables',
  views: 'Views',
  noTables: 'No tables',
  noViews: 'No views',
  noDatabases: 'No databases',
  noColumns: 'No columns',
  empty: {
    functions: 'No functions',
    procedures: 'No procedures',
    sequences: 'No sequences',
    events: 'No events',
    indexes: 'No indexes',
    foreignKeys: 'No foreign keys',
    triggers: 'No triggers',
  },
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

    it('puts folders first, then the connections outside them', async () => {
      await store.createFolder('Prod');
      await store.createFolder('Empty');
      const inside = await store.add({ name: 'In', driver: 'sqlite', file: '/db', folder: 'Prod' });
      expect(model.roots()).toEqual([
        { kind: 'connectionFolder', folder: 'Prod' },
        { kind: 'connectionFolder', folder: 'Empty' },
        { kind: 'connection', connectionId: mysql.id },
      ]);
      expect(await model.children({ kind: 'connectionFolder', folder: 'Prod' })).toEqual([
        { kind: 'connection', connectionId: inside.id },
      ]);
    });

    it('says where to drop connections in an empty folder', async () => {
      await store.createFolder('Empty');
      expect(await model.children({ kind: 'connectionFolder', folder: 'Empty' })).toEqual([
        { kind: 'message', text: 'Drag here', folder: 'Empty' },
      ]);
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

    it('shows only what the filter lets through, then how many it hid (V4.10)', async () => {
      drivers.driver('mysql').sessionMetadata.databases = ['app', 'app_test', 'shop', 'mysql'];
      await store.setFilter(mysql.id, { databases: ['app*', '!app_test'] });
      const withHidden = new TreeModel({
        store,
        manager,
        cache,
        settings: { showSystemObjects: () => showSystemObjects },
        logger,
        texts: { ...TEXTS, hiddenByFilter: (count) => `${count} hidden` },
      });
      expect(await withHidden.children({ kind: 'connection', connectionId: mysql.id })).toEqual([
        { kind: 'database', connectionId: mysql.id, database: 'app' },
        // System databases are hidden by the setting, not counted as filtered.
        { kind: 'message', text: '2 hidden', connectionId: mysql.id },
      ]);
    });

    it('says only how many are hidden when the filter hides them all', async () => {
      drivers.driver('mysql').sessionMetadata.databases = ['app', 'shop'];
      await store.setFilter(mysql.id, { databases: ['nothing'] });
      const withHidden = new TreeModel({
        store,
        manager,
        cache,
        settings: { showSystemObjects: () => false },
        logger,
        texts: { ...TEXTS, hiddenByFilter: (count) => `${count} hidden` },
      });
      expect(await withHidden.children({ kind: 'connection', connectionId: mysql.id })).toEqual([
        { kind: 'message', text: '2 hidden', connectionId: mysql.id },
      ]);
      // Without the text, the filtered list is just shorter.
      expect(await model.children({ kind: 'connection', connectionId: mysql.id })).toEqual([
        { kind: 'message', text: 'No databases', connectionId: mysql.id },
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
        objectKinds: [],
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
        objectKinds: [],
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

    it('filters schemas the same way in every database (V4.10)', async () => {
      const pg = await store.add({
        name: 'PG3',
        driver: 'postgres',
        host: 'h',
        filter: { schemas: ['!audit'] },
      });
      const driver = drivers.driver('postgres');
      driver.capabilities = {
        databases: true,
        schemas: true,
        databaseScopedSessions: true,
        cancel: true,
        objectKinds: [],
      };
      driver.sessionMetadata.schemas = ['public', 'audit', 'sales'];
      const children = await model.children({
        kind: 'database',
        connectionId: pg.id,
        database: 'app',
      });
      expect(children.map((node) => (node.kind === 'schema' ? node.schema : node.kind))).toEqual([
        'public',
        'sales',
      ]);
    });

    it('lists schemas when the driver has them', async () => {
      const pg = await store.add({ name: 'PG', driver: 'postgres', host: 'h' });
      const driver = drivers.driver('postgres');
      driver.capabilities = {
        databases: true,
        schemas: true,
        databaseScopedSessions: true,
        cancel: true,
        objectKinds: [],
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
        objectKinds: [],
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
      expect(children.slice(0, 2)).toEqual([
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

    it('adds the Indexes, Foreign Keys and Triggers folders after the columns', async () => {
      const children = await model.children({ ...table, connectionId: mysql.id });
      const ref = { database: 'app', name: 'orders' };
      expect(children.slice(1)).toEqual([
        { kind: 'folder', folder: 'indexes', connectionId: mysql.id, table: ref },
        { kind: 'folder', folder: 'foreignKeys', connectionId: mysql.id, table: ref },
        { kind: 'folder', folder: 'triggers', connectionId: mysql.id, table: ref },
      ]);
    });

    it('gives a view its columns only', async () => {
      const children = await model.children({
        ...table,
        connectionId: mysql.id,
        tableKind: 'view',
      });
      expect(children.map((child) => child.kind)).toEqual(['column']);
    });

    it('says when a table has no columns and still offers the folders', async () => {
      drivers.driver('mysql').sessionMetadata.columns = [];
      const children = await model.children({ ...table, connectionId: mysql.id });
      expect(children[0]).toEqual({ kind: 'message', text: 'No columns', connectionId: mysql.id });
      expect(children.slice(1).map((child) => child.kind)).toEqual(['folder', 'folder', 'folder']);
    });
  });

  describe('object folders of a scope', () => {
    it('follows the driver: tables, views, then its own kinds in order', async () => {
      const driver = drivers.driver('mysql');
      driver.capabilities = {
        ...driver.capabilities,
        databases: true,
        objectKinds: ['function', 'procedure', 'trigger', 'sequence', 'event'],
      };
      driver.sessionMetadata.databases = ['app'];
      const groups = await model.children({
        kind: 'database',
        connectionId: mysql.id,
        database: 'app',
      });
      // Triggers are listed inside their tables, never as a scope folder.
      expect(groups.map((group) => (group.kind === 'group' ? group.group : group.kind))).toEqual([
        'tables',
        'views',
        'functions',
        'procedures',
        'sequences',
        'events',
      ]);
    });

    it('lists functions with their signatures and the scope they live in', async () => {
      drivers.driver('mysql').sessionMetadata.objects = [
        { name: 'total', kind: 'function', signature: 'a integer' },
        { name: 'total', kind: 'function', signature: 'a text' },
        { name: 'restock', kind: 'procedure' },
      ];
      const scope = { database: 'app', schema: 'public' };
      expect(
        await model.children({ kind: 'group', group: 'functions', connectionId: mysql.id, scope }),
      ).toEqual([
        {
          kind: 'object',
          connectionId: mysql.id,
          object: { ...scope, kind: 'function', name: 'total', signature: 'a integer' },
        },
        {
          kind: 'object',
          connectionId: mysql.id,
          object: { ...scope, kind: 'function', name: 'total', signature: 'a text' },
        },
      ]);
      expect(drivers.driver('mysql').lastSession?.metadata.calls).toContain(
        'listObjects:app/public:function',
      );
    });

    it('says when a folder is empty, in its own words', async () => {
      for (const [group, text] of [
        ['functions', 'No functions'],
        ['procedures', 'No procedures'],
        ['sequences', 'No sequences'],
        ['events', 'No events'],
      ] as const) {
        expect(
          await model.children({ kind: 'group', group, connectionId: mysql.id, scope: {} }),
        ).toEqual([{ kind: 'message', text, connectionId: mysql.id }]);
      }
    });

    it('turns a failure into a leaf', async () => {
      drivers.driver('mysql').metadataError = new DbError('permission-denied', 'No rights');
      expect(
        await model.children({ kind: 'group', group: 'events', connectionId: mysql.id, scope: {} }),
      ).toEqual([{ kind: 'message', text: 'No rights', failed: true, connectionId: mysql.id }]);
    });
  });

  describe('folders of a table', () => {
    const ref = { database: 'app', name: 'orders' };
    const folder = (name: 'indexes' | 'foreignKeys' | 'triggers'): TreeNode => ({
      kind: 'folder',
      folder: name,
      connectionId: mysql.id,
      table: ref,
    });

    it('lists indexes', async () => {
      const index = { name: 'PRIMARY', columns: ['id'], unique: true, primary: true };
      drivers.driver('mysql').sessionMetadata.indexes = [index];
      expect(await model.children(folder('indexes'))).toEqual([
        { kind: 'index', connectionId: mysql.id, table: ref, index },
      ]);
    });

    it('lists foreign keys', async () => {
      const key = {
        name: 'fk_customer',
        columns: ['customer_id'],
        target: { database: 'app', name: 'customers' },
        targetColumns: ['id'],
      };
      drivers.driver('mysql').sessionMetadata.foreignKeys = [key];
      expect(await model.children(folder('foreignKeys'))).toEqual([
        { kind: 'foreignKey', connectionId: mysql.id, table: ref, key },
      ]);
    });

    it('lists only the triggers of this table', async () => {
      drivers.driver('mysql').sessionMetadata.objects = [
        { name: 'audit', kind: 'trigger', table: 'orders' },
        { name: 'other', kind: 'trigger', table: 'customers' },
      ];
      expect(await model.children(folder('triggers'))).toEqual([
        {
          kind: 'object',
          connectionId: mysql.id,
          object: { database: 'app', kind: 'trigger', name: 'audit', table: 'orders' },
        },
      ]);
      expect(drivers.driver('mysql').lastSession?.metadata.calls).toContain(
        'listObjects:app/:trigger',
      );
    });

    it('says when a folder is empty', async () => {
      expect(await model.children(folder('indexes'))).toEqual([
        { kind: 'message', text: 'No indexes', connectionId: mysql.id },
      ]);
      expect(await model.children(folder('foreignKeys'))).toEqual([
        { kind: 'message', text: 'No foreign keys', connectionId: mysql.id },
      ]);
      expect(await model.children(folder('triggers'))).toEqual([
        { kind: 'message', text: 'No triggers', connectionId: mysql.id },
      ]);
    });

    it('keeps the schema of a table in the trigger lookup', async () => {
      const pg = drivers.driver('mysql');
      await model.children({
        kind: 'folder',
        folder: 'triggers',
        connectionId: mysql.id,
        table: { schema: 'sales', name: 'orders' },
      });
      expect(pg.lastSession?.metadata.calls).toContain('listObjects:/sales:trigger');
    });
  });

  describe('leaves', () => {
    it('objects, indexes and keys have no children', async () => {
      const table = { name: 't' };
      for (const node of [
        { kind: 'object', connectionId: mysql.id, object: { kind: 'event', name: 'e' } },
        {
          kind: 'index',
          connectionId: mysql.id,
          table,
          index: { name: 'i', columns: ['a'], unique: false, primary: false },
        },
        {
          kind: 'foreignKey',
          connectionId: mysql.id,
          table,
          key: { name: 'f', columns: ['a'], target: { name: 'u' }, targetColumns: ['id'] },
        },
      ] as TreeNode[]) {
        expect(await model.children(node)).toEqual([]);
      }
    });

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

describe('TreeModel project connections (V4.7)', () => {
  const SHOP: ProjectFolder = { key: 'file:///shop', name: 'shop', root: '/shop' };
  const BLOG: ProjectFolder = { key: 'file:///blog', name: 'blog', root: '/blog' };
  const texts: TreeTexts = {
    ...TEXTS,
    project: {
      untrusted: (count) => `untrusted ${count}`,
      broken: (error) => `broken: ${error}`,
      skipped: (position, problem) => `#${position}: ${problem}`,
      empty: 'none yet',
    },
  };

  async function setup(files: Record<string, string>, trusted = true) {
    const logger = new RecordingLogger();
    const projects = new ProjectConnections({
      files: {
        read: (folder) => Promise.resolve(files[folder.key]),
        write: () => Promise.resolve(),
      },
      logger,
    });
    await projects.load([SHOP, BLOG], trusted);
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
      projects,
    });
    const manager = new ConnectionManager({ store, drivers: new FakeDriverProvider(), logger });
    const model = new TreeModel({
      store,
      projects,
      manager,
      cache: new MetadataCache({ logger }),
      settings: { showSystemObjects: () => false },
      logger,
      texts,
    });
    return { model, store };
  }

  const list = (...connections: unknown[]) => JSON.stringify({ connections });

  it('shows projects with a file first, then the user folders and connections', async () => {
    const { model, store } = await setup({
      [SHOP.key]: list({ id: 'dev', name: 'Dev', driver: 'mysql', host: 'h' }),
    });
    await store.createFolder('Work');
    const own = await store.add({ name: 'Mine', driver: 'sqlite', file: '/db' });
    expect(model.roots()).toEqual([
      { kind: 'project', key: SHOP.key, name: 'shop' },
      { kind: 'connectionFolder', folder: 'Work' },
      { kind: 'connection', connectionId: own.id },
    ]);
  });

  it('lists the connections of a project under it, then the skipped entries', async () => {
    const { model } = await setup({
      [SHOP.key]: list(
        { id: 'dev', name: 'Dev', driver: 'mysql', host: 'h' },
        { name: 'Broken', driver: 'mysql' },
      ),
    });
    expect(await model.children({ kind: 'project', key: SHOP.key, name: 'shop' })).toEqual([
      { kind: 'connection', connectionId: projectConnectionId(SHOP.key, 'dev') },
      { kind: 'message', text: '#2: host-empty', failed: true },
    ]);
  });

  it('says so when the file lists nothing, is broken or the workspace is untrusted', async () => {
    const node = { kind: 'project', key: SHOP.key, name: 'shop' } as const;
    expect(await (await setup({ [SHOP.key]: list() })).model.children(node)).toEqual([
      { kind: 'message', text: 'none yet' },
    ]);
    const broken = await (await setup({ [SHOP.key]: '{' })).model.children(node);
    expect(broken).toMatchObject([{ kind: 'message', failed: true }]);
    expect((broken[0] as { text: string }).text).toMatch(/^broken: /);
    const untrusted = await setup(
      { [SHOP.key]: list({ name: 'A', driver: 'mysql', host: 'h' }) },
      false,
    );
    expect(untrusted.model.roots()).toEqual([node]);
    expect(await untrusted.model.children(node)).toEqual([
      { kind: 'message', text: 'untrusted 1' },
    ]);
  });

  it('lists nothing for a project that is gone', async () => {
    const { model } = await setup({});
    expect(await model.children({ kind: 'project', key: SHOP.key, name: 'shop' })).toEqual([]);
  });
});
