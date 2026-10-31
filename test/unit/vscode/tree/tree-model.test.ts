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
import { bulk, FakeRedisDriver, type FakeRedisSession } from '../../../helpers/fake-redis';
import { RedisKeyBrowser } from '../../../../src/services/redis/key-browser';
import { bool, doc, int32, str } from '../../../../src/core/mongo/value';
import { FakeElasticDriver, FakeElasticSession, json } from '../../../helpers/fake-elastic';
import {
  collection,
  FakeMongoDriver,
  FakeMongoSession,
  indexSpec,
} from '../../../helpers/fake-mongo';

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
        transactions: true,
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
        transactions: true,
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
        transactions: true,
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
        transactions: true,
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
        transactions: true,
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

    it('puts the statistics of the server on each table (V10.2.3)', async () => {
      const metadata = drivers.driver('mysql').sessionMetadata;
      metadata.tables = [
        { name: 'orders', kind: 'table' },
        { name: 'quiet', kind: 'table' },
      ];
      metadata.tableStats = () =>
        Promise.resolve([
          { name: 'orders', rows: 1200, bytes: 65536, comment: 'All orders' },
          { name: 'gone', rows: 5 },
        ]);
      const nodes = await model.children(group());
      expect(nodes).toEqual([
        {
          kind: 'table',
          connectionId: mysql.id,
          scope: {},
          name: 'orders',
          tableKind: 'table',
          stats: { name: 'orders', rows: 1200, bytes: 65536, comment: 'All orders' },
        },
        { kind: 'table', connectionId: mysql.id, scope: {}, name: 'quiet', tableKind: 'table' },
      ]);
    });

    it('reads the statistics once, from the cache after that', async () => {
      const metadata = drivers.driver('mysql').sessionMetadata;
      let reads = 0;
      metadata.tableStats = () => {
        reads++;
        return Promise.resolve([{ name: 'customers', rows: 1 }]);
      };
      await model.children(group());
      await model.children(group());
      expect(reads).toBe(1);
    });

    it('lists the tables without statistics when the setting is off', async () => {
      let reads = 0;
      drivers.driver('mysql').sessionMetadata.tableStats = () => {
        reads++;
        return Promise.resolve([{ name: 'customers', rows: 1 }]);
      };
      const quiet = new TreeModel({
        store,
        manager,
        cache,
        settings: { showSystemObjects: () => false, tableStats: () => false },
        logger,
        texts: TEXTS,
      });
      expect(await quiet.children(group())).toEqual([
        { kind: 'table', connectionId: mysql.id, scope: {}, name: 'customers', tableKind: 'table' },
      ]);
      expect(reads).toBe(0);
    });

    it('still lists the tables when the statistics fail, and says so in the log', async () => {
      drivers.driver('mysql').sessionMetadata.tableStats = () =>
        Promise.reject(new DbError('permission-denied', 'no access to the statistics'));
      expect(await model.children(group())).toEqual([
        { kind: 'table', connectionId: mysql.id, scope: {}, name: 'customers', tableKind: 'table' },
      ]);
      expect(logger.entries.some((entry) => entry.message.includes('statistics'))).toBe(true);
    });

    it('shows only what the Filter… lets through, then how many it hid (V10.2.3)', async () => {
      drivers.driver('mysql').sessionMetadata.tables = [
        { name: 'orders', kind: 'table' },
        { name: 'order_items', kind: 'table' },
        { name: 'customers', kind: 'table' },
        { name: 'order_totals', kind: 'view' },
      ];
      const tables = group();
      const texts = { ...TEXTS, hiddenByFilter: (count: number) => `${count} hidden` };
      const filtered = new TreeModel({
        store,
        manager,
        cache,
        settings: { showSystemObjects: () => false },
        logger,
        texts,
      });
      expect(tables.kind === 'group' && filtered.groupFilter(tables)).toBe(undefined);
      if (tables.kind !== 'group') {
        return;
      }
      filtered.setGroupFilter(tables, '  order ');
      expect(filtered.groupFilter(tables)).toBe('order');
      expect(
        (await filtered.children(tables)).map((node) =>
          node.kind === 'table' ? node.name : node.kind === 'message' ? node.text : '',
        ),
      ).toEqual(['orders', 'order_items', '1 hidden']);
      // Each folder has its own filter; the Views folder is not filtered.
      const views: TreeNode = { kind: 'group', group: 'views', connectionId: mysql.id, scope: {} };
      expect((await filtered.children(views)).length).toBe(1);
      filtered.setGroupFilter(tables, 'nothing*');
      expect(await filtered.children(tables)).toEqual([
        { kind: 'message', text: '3 hidden', connectionId: mysql.id },
      ]);
      filtered.setGroupFilter(tables, '');
      expect(filtered.groupFilter(tables)).toBeUndefined();
      expect(await filtered.children(tables)).toHaveLength(3);
      filtered.setGroupFilter(tables, 'order');
      filtered.setGroupFilter(tables, undefined);
      expect(filtered.groupFilter(tables)).toBeUndefined();
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

describe('TreeModel with Redis (V7.1)', () => {
  const KEYSPACE = 'db0:keys=12,expires=1\r\ndb3:keys=1,expires=0\r\n';

  async function setup(answer?: ConstructorParameters<typeof FakeRedisDriver>[0]) {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const redis = new FakeRedisDriver(
      answer ??
        ((words) =>
          words[0] === 'INFO'
            ? bulk(KEYSPACE)
            : words[0] === 'CONFIG'
              ? [bulk('databases'), bulk('4')]
              : null),
    );
    const drivers = Object.assign(new FakeDriverProvider(), {
      getRedis: () => Promise.resolve(redis),
    });
    const manager = new ConnectionManager({ store, drivers, logger });
    const model = new TreeModel({
      store,
      manager,
      cache: new MetadataCache({ logger }),
      settings: { showSystemObjects: () => false },
      logger,
      texts: { ...TEXTS, redisKeys: (count) => `${count} keys` },
    });
    const cache = await store.add({ name: 'Cache', driver: 'redis', host: 'h', database: '3' });
    return { store, redis, drivers, manager, model, cache };
  }

  it('lists the numbered databases with their keys, connecting on the opened one', async () => {
    const { model, cache, redis, manager, drivers } = await setup();
    expect(await model.children({ kind: 'connection', connectionId: cache.id })).toEqual([
      { kind: 'redisDatabase', connectionId: cache.id, database: 0, keys: 12 },
      { kind: 'redisDatabase', connectionId: cache.id, database: 1, keys: 0 },
      { kind: 'redisDatabase', connectionId: cache.id, database: 2, keys: 0 },
      { kind: 'redisDatabase', connectionId: cache.id, database: 3, keys: 1 },
    ]);
    expect(redis.opened[0]?.database).toBe('3');
    expect(manager.redisSessionOf(ConnectionManager.treeOwner(cache.id, '3'))).toBeDefined();
    // No SQL driver is loaded for a Redis connection.
    expect(drivers.requested).toEqual([]);
  });

  it('turns a failure into a leaf that says what went wrong', async () => {
    const { model, cache, redis } = await setup();
    redis.openError = new DbError('auth-failed', 'WRONGPASS invalid password');
    expect(await model.children({ kind: 'connection', connectionId: cache.id })).toEqual([
      { kind: 'message', text: 'WRONGPASS invalid password', failed: true, connectionId: cache.id },
    ]);
  });

  it('has nothing below a database yet', async () => {
    const { model, cache } = await setup();
    expect(
      await model.children({ kind: 'redisDatabase', connectionId: cache.id, database: 0, keys: 1 }),
    ).toEqual([]);
  });

  it('describes the key count with the given text, or the bare number', async () => {
    const { model } = await setup();
    expect(model.redisKeysText(5)).toBe('5 keys');
    const bare = new TreeModel({
      store: new ConnectionStore({
        state: new FakeMemento(),
        secrets: new FakeSecretStorage(),
        logger: new RecordingLogger(),
      }),
      manager: {} as ConnectionManager,
      cache: new MetadataCache({ logger: new RecordingLogger() }),
      settings: { showSystemObjects: () => false },
      logger: new RecordingLogger(),
      texts: TEXTS,
    });
    expect(bare.redisKeysText(5)).toBe('5');
  });
});

describe('TreeModel with Redis keys (V7.2)', () => {
  async function setup(keys: string[], perLoad = 5000) {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const redis = new FakeRedisDriver((words) =>
      words[0] === 'TYPE' ? bulk(words[1]?.startsWith('hash:') ? 'hash' : 'string') : null,
    );
    const drivers = Object.assign(new FakeDriverProvider(), {
      getRedis: () => Promise.resolve(redis),
    });
    const manager = new ConnectionManager({ store, drivers, logger });
    const original = redis.openSession.bind(redis);
    redis.openSession = async (config) => {
      const session = (await original(config)) as FakeRedisSession;
      session.keyspace = [keys];
      return session;
    };
    const redisKeys = new RedisKeyBrowser({
      manager,
      settings: { separator: () => ':', keysPerLoad: () => perLoad },
      logger,
    });
    const model = new TreeModel({
      store,
      manager,
      cache: new MetadataCache({ logger }),
      settings: { showSystemObjects: () => false },
      logger,
      texts: {
        ...TEXTS,
        noKeys: (pattern) => (pattern === undefined ? 'No keys' : `None match ${pattern}`),
      },
      redisKeys,
      redisKeySeparator: () => ':',
    });
    const cache = await store.add({ name: 'Cache', driver: 'redis', host: 'h' });
    const database = {
      kind: 'redisDatabase',
      connectionId: cache.id,
      database: 0,
      keys: 0,
    } as const;
    return { model, cache, redisKeys, database, store };
  }

  it('shows folders, then keys, below a database', async () => {
    const { model, cache, database } = await setup(['user:1', 'user:2', 'hits']);
    expect(await model.children(database)).toEqual([
      {
        kind: 'redisFolder',
        connectionId: cache.id,
        database: 0,
        path: ['user'],
        prefix: 'user:',
        count: 2,
      },
      {
        kind: 'redisKey',
        connectionId: cache.id,
        database: 0,
        key: { text: 'hits' },
        name: 'hits',
        keyType: 'string',
      },
    ]);
    expect(
      await model.children({
        kind: 'redisFolder',
        connectionId: cache.id,
        database: 0,
        path: ['user'],
        prefix: 'user:',
        count: 2,
      }),
    ).toEqual([
      {
        kind: 'redisKey',
        connectionId: cache.id,
        database: 0,
        key: { text: 'user:1' },
        name: '1',
        keyType: 'string',
      },
      {
        kind: 'redisKey',
        connectionId: cache.id,
        database: 0,
        key: { text: 'user:2' },
        name: '2',
        keyType: 'string',
      },
    ]);
  });

  it('ends a database with "load more" while SCAN has not reached the end', async () => {
    const keys = Array.from({ length: 1500 }, (_value, index) => `k${index}`);
    const { model, cache, database } = await setup(keys, 1000);
    const children = await model.children(database);
    expect(children.at(-1)).toEqual({
      kind: 'redisMore',
      connectionId: cache.id,
      database: 0,
      loaded: 1000,
    });
  });

  it('says when there are no keys, naming the filter', async () => {
    const { model, cache, database, redisKeys } = await setup([]);
    expect(await model.children(database)).toEqual([
      { kind: 'message', text: 'No keys', connectionId: cache.id },
    ]);
    redisKeys.setPattern(cache.id, 0, 'x*');
    expect(await model.children(database)).toEqual([
      { kind: 'message', text: 'None match x*', connectionId: cache.id },
    ]);
  });

  it('has nothing below a key or "load more"', async () => {
    const { model, cache } = await setup(['a']);
    expect(
      await model.children({ kind: 'redisMore', connectionId: cache.id, database: 0, loaded: 1 }),
    ).toEqual([]);
    expect(
      await model.children({
        kind: 'redisKey',
        connectionId: cache.id,
        database: 0,
        key: { text: 'a' },
        name: 'a',
      }),
    ).toEqual([]);
  });

  it('knows the parents of a key, up to the connection folder, for reveal', async () => {
    const { model, cache, database, store } = await setup(['user:1:name']);
    await model.children(database);
    const key = {
      kind: 'redisKey',
      connectionId: cache.id,
      database: 0,
      key: { text: 'user:1:name' },
      name: 'name',
    } as const;
    const folder = model.parentOf(key);
    expect(folder).toEqual({
      kind: 'redisFolder',
      connectionId: cache.id,
      database: 0,
      path: ['user', '1'],
      prefix: 'user:1:',
      count: 0,
    });
    const top = folder === undefined ? undefined : model.parentOf(folder);
    expect(top).toMatchObject({ kind: 'redisFolder', path: ['user'] });
    const db = top === undefined ? undefined : model.parentOf(top);
    expect(db).toMatchObject({ kind: 'redisDatabase', database: 0 });
    expect(db === undefined ? undefined : model.parentOf(db)).toEqual({
      kind: 'connection',
      connectionId: cache.id,
    });
    expect(model.parentOf({ kind: 'connection', connectionId: cache.id })).toBeUndefined();
    await store.createFolder('Work');
    await store.moveConnections([cache.id], { folder: 'Work' });
    expect(model.parentOf({ kind: 'connection', connectionId: cache.id })).toEqual({
      kind: 'connectionFolder',
      folder: 'Work',
    });
    expect(
      model.parentOf({ kind: 'redisMore', connectionId: cache.id, database: 2, loaded: 0 }),
    ).toMatchObject({ kind: 'redisDatabase', database: 2 });
    expect(
      model.parentOf({ kind: 'database', connectionId: cache.id, database: 'x' }),
    ).toBeUndefined();
  });

  it('remembers the key count of a database it listed, for parents', async () => {
    const { model, cache } = await setup(['a']);
    await model.children({ kind: 'connection', connectionId: cache.id });
    expect(
      model.parentOf({ kind: 'redisMore', connectionId: cache.id, database: 0, loaded: 0 }),
    ).toEqual({
      kind: 'redisDatabase',
      connectionId: cache.id,
      database: 0,
      keys: 0,
    });
  });
});

describe('TreeModel with MongoDB (V7.5)', () => {
  async function setup(options: { showSystem?: boolean; filter?: string[] } = {}) {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const server = new FakeMongoSession();
    server.databases = [
      { name: 'shop', sizeOnDisk: 2048 },
      { name: 'admin' },
      { name: 'local' },
      { name: 'logs' },
    ];
    server.collections.set('shop', [
      collection('orders'),
      collection('big_orders', 'view', doc([['viewOn', str('orders')]])),
      collection('events', 'collection', doc([['capped', bool(true)]])),
      collection('metrics', 'timeseries'),
      collection('system.views'),
    ]);
    server.indexes.set('shop.orders', [
      indexSpec('status_1', doc([['status', int32(1)]])),
      indexSpec('_id_', doc([['_id', int32(1)]])),
    ]);
    const mongo = new FakeMongoDriver(() => server);
    const drivers = Object.assign(new FakeDriverProvider(), {
      getMongo: () => Promise.resolve(mongo),
    });
    const manager = new ConnectionManager({ store, drivers, logger });
    const model = new TreeModel({
      store,
      manager,
      cache: new MetadataCache({ logger }),
      settings: { showSystemObjects: () => options.showSystem === true },
      logger,
      texts: {
        ...TEXTS,
        noCollections: 'No collections',
        hiddenByFilter: (count) => `${count} hidden`,
      },
    });
    const shop = await store.add({
      name: 'Shop',
      driver: 'mongodb',
      host: 'h',
      ...(options.filter === undefined ? {} : { filter: { databases: options.filter } }),
    });
    return { model, shop, server, mongo, drivers, manager };
  }

  it('lists the databases with their size, without the server’s own', async () => {
    const { model, shop, drivers, manager } = await setup();
    expect(await model.children({ kind: 'connection', connectionId: shop.id })).toEqual([
      { kind: 'mongoDatabase', connectionId: shop.id, database: 'logs' },
      { kind: 'mongoDatabase', connectionId: shop.id, database: 'shop', sizeOnDisk: 2048 },
    ]);
    expect(manager.mongoSessionOf(ConnectionManager.treeOwner(shop.id))).toBeDefined();
    expect(drivers.requested).toEqual([]);
  });

  it('shows the server’s databases when asked, and applies the filter', async () => {
    const all = await setup({ showSystem: true });
    expect(
      (await all.model.children({ kind: 'connection', connectionId: all.shop.id })).map(
        (node) => node.kind === 'mongoDatabase' && node.database,
      ),
    ).toEqual(['admin', 'local', 'logs', 'shop']);
    const filtered = await setup({ filter: ['sh*'] });
    expect(
      await filtered.model.children({ kind: 'connection', connectionId: filtered.shop.id }),
    ).toEqual([
      { kind: 'mongoDatabase', connectionId: filtered.shop.id, database: 'shop', sizeOnDisk: 2048 },
      { kind: 'message', text: '1 hidden', connectionId: filtered.shop.id },
    ]);
  });

  it('says so when there is no database', async () => {
    const { model, shop, server } = await setup();
    server.databases = [];
    expect(await model.children({ kind: 'connection', connectionId: shop.id })).toEqual([
      { kind: 'message', text: 'No databases', connectionId: shop.id },
    ]);
  });

  it('lists collections, then views, with what sets them apart', async () => {
    const { model, shop } = await setup();
    const database = { kind: 'mongoDatabase' as const, connectionId: shop.id, database: 'shop' };
    expect(await model.children(database)).toEqual([
      {
        kind: 'mongoCollection',
        connectionId: shop.id,
        database: 'shop',
        collection: 'events',
        collectionType: 'collection',
        capped: true,
      },
      {
        kind: 'mongoCollection',
        connectionId: shop.id,
        database: 'shop',
        collection: 'metrics',
        collectionType: 'timeseries',
      },
      {
        kind: 'mongoCollection',
        connectionId: shop.id,
        database: 'shop',
        collection: 'orders',
        collectionType: 'collection',
      },
      {
        kind: 'mongoCollection',
        connectionId: shop.id,
        database: 'shop',
        collection: 'big_orders',
        collectionType: 'view',
        viewOn: 'orders',
      },
    ]);
    expect(
      await model.children({ kind: 'mongoDatabase', connectionId: shop.id, database: 'empty' }),
    ).toEqual([{ kind: 'message', text: 'No collections', connectionId: shop.id }]);
  });

  it('lists the indexes of a collection, and nothing below a view', async () => {
    const { model, shop } = await setup();
    const orders = {
      kind: 'mongoCollection' as const,
      connectionId: shop.id,
      database: 'shop',
      collection: 'orders',
      collectionType: 'collection' as const,
    };
    const indexes = await model.children(orders);
    expect(indexes.map((node) => node.kind === 'mongoIndex' && node.index.name)).toEqual([
      '_id_',
      'status_1',
    ]);
    expect(await model.children({ ...orders, collection: 'other' })).toEqual([
      { kind: 'message', text: 'No indexes', connectionId: shop.id },
    ]);
    expect(await model.children({ ...orders, collectionType: 'view' })).toEqual([]);
    const [index] = indexes;
    expect(index === undefined ? [] : await model.children(index)).toEqual([]);
  });

  it('turns a failure into a leaf that says what went wrong', async () => {
    const { model, shop, mongo } = await setup();
    mongo.failure = new DbError('auth-failed', 'Authentication failed.');
    expect(await model.children({ kind: 'connection', connectionId: shop.id })).toEqual([
      { kind: 'message', text: 'Authentication failed.', failed: true, connectionId: shop.id },
    ]);
  });

  it('has no parent for MongoDB nodes: they are never revealed', async () => {
    const { model, shop } = await setup();
    expect(
      model.parentOf({ kind: 'mongoDatabase', connectionId: shop.id, database: 'shop' }),
    ).toBeUndefined();
  });
});

describe('TreeModel with Elasticsearch (V7.8)', () => {
  async function setup(showSystem = false) {
    const logger = new RecordingLogger();
    const store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    const server = new FakeElasticSession((request) =>
      request.path.startsWith('/_cat/indices')
        ? json([
            { index: 'products', health: 'green', status: 'open', 'docs.count': '3' },
            { index: '.hidden', health: 'green', status: 'open' },
          ])
        : request.path === '/empty/_mapping'
          ? json({ empty: { mappings: {} } })
          : json({
              products: {
                mappings: {
                  properties: {
                    name: { type: 'text', fields: { keyword: { type: 'keyword' } } },
                    stock: { type: 'long' },
                  },
                },
              },
            }),
    );
    const elastic = new FakeElasticDriver(() => server);
    const drivers = Object.assign(new FakeDriverProvider(), {
      getElastic: () => Promise.resolve(elastic),
    });
    const manager = new ConnectionManager({ store, drivers, logger });
    const model = new TreeModel({
      store,
      manager,
      cache: new MetadataCache({ logger }),
      settings: { showSystemObjects: () => showSystem },
      logger,
      texts: { ...TEXTS, noIndices: 'No indices', noFields: 'No fields' },
    });
    const search = await store.add({ name: 'Search', driver: 'elasticsearch', host: 'h' });
    return { model, search, elastic, drivers };
  }

  it('lists the indices of a connection, hidden ones only when asked', async () => {
    const { model, search, drivers } = await setup();
    expect(await model.children({ kind: 'connection', connectionId: search.id })).toEqual([
      {
        kind: 'elasticIndex',
        connectionId: search.id,
        index: { name: 'products', health: 'green', status: 'open', docs: '3', hidden: false },
      },
    ]);
    expect(drivers.requested).toEqual([]);
    const all = await setup(true);
    expect(
      await all.model.children({ kind: 'connection', connectionId: all.search.id }),
    ).toHaveLength(2);
  });

  it('lists the fields of an index and the fields inside a field', async () => {
    const { model, search } = await setup();
    const fields = await model.children({
      kind: 'elasticIndex',
      connectionId: search.id,
      index: { name: 'products', status: 'open', hidden: false },
    });
    expect(fields.map((node) => node.kind === 'elasticField' && node.field.path)).toEqual([
      'name',
      'stock',
    ]);
    const [name] = fields;
    expect(
      name === undefined
        ? []
        : (await model.children(name)).map(
            (node) => node.kind === 'elasticField' && node.field.path,
          ),
    ).toEqual(['name.keyword']);
    expect(
      await model.children({
        kind: 'elasticIndex',
        connectionId: search.id,
        index: { name: 'empty', status: 'open', hidden: false },
      }),
    ).toEqual([{ kind: 'message', text: 'No fields', connectionId: search.id }]);
  });

  it('says so when there is no index, and turns a failure into a leaf', async () => {
    const { model, search, elastic } = await setup();
    elastic.failure = new DbError('auth-failed', 'security_exception: unable to authenticate');
    expect(await model.children({ kind: 'connection', connectionId: search.id })).toEqual([
      {
        kind: 'message',
        text: 'security_exception: unable to authenticate',
        failed: true,
        connectionId: search.id,
      },
    ]);
  });
});
