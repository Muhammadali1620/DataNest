import { beforeEach, describe, expect, it } from 'vitest';
import { ConnectionManager } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import { MetadataCache } from '../../../src/services/metadata-cache';
import { indexConnection, MAX_OBJECTS_PER_CONNECTION } from '../../../src/services/object-index';
import { FakeDriverProvider } from '../../helpers/fake-driver';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';

describe('indexConnection', () => {
  let store: ConnectionStore;
  let drivers: FakeDriverProvider;
  let manager: ConnectionManager;
  let cache: MetadataCache;
  let showSystem: boolean;

  beforeEach(() => {
    const logger = new RecordingLogger();
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    drivers = new FakeDriverProvider();
    manager = new ConnectionManager({ store, drivers, logger });
    cache = new MetadataCache({ logger });
    showSystem = false;
  });

  const index = async (connectionId: string) =>
    await indexConnection(
      { manager, store, cache, showSystemObjects: () => showSystem },
      connectionId,
    );

  it('lists tables, views and the driver kinds of every visible database', async () => {
    const config = await store.add({ name: 'My', driver: 'mysql', host: 'h' });
    const driver = drivers.driver('mysql');
    driver.capabilities = { ...driver.capabilities, objectKinds: ['function', 'event'] };
    driver.sessionMetadata.databases = ['information_schema', 'shop'];
    driver.sessionMetadata.tables = [
      { name: 'orders', kind: 'table' },
      { name: 'totals', kind: 'view' },
    ];
    driver.sessionMetadata.objects = [
      { name: 'total', kind: 'function' },
      { name: 'nightly', kind: 'event' },
      { name: 'ignored', kind: 'procedure' },
    ];
    expect(await index(config.id)).toEqual([
      { connectionId: config.id, database: 'shop', kind: 'table', name: 'orders' },
      { connectionId: config.id, database: 'shop', kind: 'view', name: 'totals' },
      { connectionId: config.id, database: 'shop', kind: 'function', name: 'total' },
      { connectionId: config.id, database: 'shop', kind: 'event', name: 'nightly' },
    ]);
  });

  it('includes the server databases when the setting asks for them', async () => {
    const config = await store.add({ name: 'My', driver: 'mysql', host: 'h' });
    drivers.driver('mysql').sessionMetadata.databases = ['information_schema', 'shop'];
    showSystem = true;
    const found = await index(config.id);
    expect(new Set(found.map((o) => o.database))).toEqual(new Set(['information_schema', 'shop']));
  });

  it('searches only the databases and schemas the connection filter shows (V4.10)', async () => {
    const mine = await store.add({
      name: 'My',
      driver: 'mysql',
      host: 'h',
      filter: { databases: ['!archive'] },
    });
    const driver = drivers.driver('mysql');
    driver.sessionMetadata.databases = ['shop', 'archive'];
    driver.sessionMetadata.tables = [{ name: 'orders', kind: 'table' }];
    expect(new Set((await index(mine.id)).map((o) => o.database))).toEqual(new Set(['shop']));

    const pg = await store.add({
      name: 'PG',
      driver: 'postgres',
      host: 'h',
      database: 'app',
      filter: { schemas: ['sales'] },
    });
    const postgres = drivers.driver('postgres');
    postgres.capabilities = {
      ...postgres.capabilities,
      schemas: true,
      databaseScopedSessions: true,
    };
    postgres.sessionMetadata.databases = ['app'];
    postgres.sessionMetadata.schemas = ['public', 'sales'];
    postgres.sessionMetadata.tables = [{ name: 't', kind: 'table' }];
    expect(new Set((await index(pg.id)).map((o) => o.schema))).toEqual(new Set(['sales']));
  });

  it('searches the schemas of the connection database where sessions see one database', async () => {
    const config = await store.add({ name: 'PG', driver: 'postgres', host: 'h', database: 'app' });
    const driver = drivers.driver('postgres');
    driver.capabilities = {
      ...driver.capabilities,
      schemas: true,
      databaseScopedSessions: true,
      objectKinds: ['sequence'],
    };
    driver.sessionMetadata.databases = ['app', 'other'];
    driver.sessionMetadata.schemas = ['public', 'pg_catalog', 'sales'];
    driver.sessionMetadata.tables = [{ name: 'mv', kind: 'view', materialized: true }];
    driver.sessionMetadata.objects = [{ name: 'seq', kind: 'sequence' }];
    const found = await index(config.id);
    expect(found).toEqual([
      {
        connectionId: config.id,
        database: 'app',
        schema: 'public',
        kind: 'view',
        name: 'mv',
        materialized: true,
      },
      { connectionId: config.id, database: 'app', schema: 'public', kind: 'sequence', name: 'seq' },
      {
        connectionId: config.id,
        database: 'app',
        schema: 'sales',
        kind: 'view',
        name: 'mv',
        materialized: true,
      },
      { connectionId: config.id, database: 'app', schema: 'sales', kind: 'sequence', name: 'seq' },
    ]);
    expect(driver.opened.map((c) => c.database)).not.toContain('other');
  });

  it('lists a file database without databases or schemas, with routine details', async () => {
    const config = await store.add({ name: 'File', driver: 'sqlite', file: '/db' });
    const driver = drivers.driver('sqlite');
    driver.capabilities = { ...driver.capabilities, databases: false, objectKinds: ['function'] };
    driver.sessionMetadata.tables = [];
    driver.sessionMetadata.objects = [{ name: 'f', kind: 'function', signature: 'a int' }];
    expect(await index(config.id)).toEqual([
      { connectionId: config.id, kind: 'function', name: 'f', signature: 'a int' },
    ]);
  });

  it('caps a huge connection', async () => {
    const config = await store.add({ name: 'File', driver: 'sqlite', file: '/db' });
    const driver = drivers.driver('sqlite');
    driver.capabilities = { ...driver.capabilities, databases: false };
    driver.sessionMetadata.tables = Array.from(
      { length: MAX_OBJECTS_PER_CONNECTION + 5 },
      (_, n) => ({
        name: `t${n}`,
        kind: 'table' as const,
      }),
    );
    expect(await index(config.id)).toHaveLength(MAX_OBJECTS_PER_CONNECTION);
  });

  it('finds nothing for a connection that does not exist', async () => {
    expect(await index('missing')).toEqual([]);
  });

  it('lets a server failure reach the caller', async () => {
    const config = await store.add({ name: 'My', driver: 'mysql', host: 'h' });
    drivers.driver('mysql').metadataError = new Error('denied');
    await expect(index(config.id)).rejects.toThrow('denied');
  });
});
