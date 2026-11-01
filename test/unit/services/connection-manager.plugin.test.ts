// Connections of drivers that other extensions registered (V12.7), end to end through the
// real adapter: the manager asks the provider for the plugin's driver, the session runs
// statements, and everything that goes wrong reads as a DbError.

import { beforeEach, describe, expect, it } from 'vitest';
import type { Driver } from '../../../src/drivers/driver';
import { PluginDrivers } from '../../../src/drivers/plugin/plugin-drivers';
import { ConnectionManager, type DriverProvider } from '../../../src/services/connection-manager';
import { ConnectionStore } from '../../../src/services/connection-store';
import type { ConnectionConfig } from '../../../src/shared/connection';
import { FakeMemento, FakeSecretStorage, RecordingLogger } from '../../helpers/fakes';
import { FakePlugin } from '../../helpers/fake-plugin';

describe('ConnectionManager with a plugin driver', () => {
  let store: ConnectionStore;
  let plugins: PluginDrivers;
  let plugin: FakePlugin;
  let manager: ConnectionManager;
  let config: ConnectionConfig;

  const provider = (withPlugins: boolean): DriverProvider => ({
    get: () => Promise.reject(new Error('no built-in driver here')),
    ...(withPlugins
      ? { getPlugin: (id: string): Promise<Driver> => Promise.resolve(plugins.get(id)) }
      : {}),
  });

  beforeEach(async () => {
    const logger = new RecordingLogger();
    store = new ConnectionStore({
      state: new FakeMemento(),
      secrets: new FakeSecretStorage(),
      logger,
    });
    plugins = new PluginDrivers();
    plugin = new FakePlugin();
    plugins.register(plugin);
    manager = new ConnectionManager({ store, drivers: provider(true), logger });
    config = await store.add(
      {
        name: 'Fake',
        driver: 'plugin',
        plugin: 'acme.fake',
        host: 'db.local',
        port: 4000,
        user: 'ann',
        database: 'main',
        file: '/tmp/x.db',
      },
      'secret',
    );
  });

  it('opens a session through the plugin and runs a statement', async () => {
    const session = await manager.acquire('editor:a', { connectionId: config.id });
    const events = [];
    for await (const event of session.execute('SELECT 1')) {
      events.push(event);
    }
    expect(events.at(-1)).toEqual({ kind: 'done' });
    expect(plugin.sessions[0]?.executed).toEqual(['SELECT 1']);
    expect(plugin.opened[0]).toEqual({
      host: 'db.local',
      port: 4000,
      user: 'ann',
      password: 'secret',
      database: 'main',
      file: '/tmp/x.db',
      readOnly: false,
    });
    expect(manager.getState(config.id).status).toBe('connected');
  });

  it('tells the plugin when the connection is read-only', async () => {
    const readOnly = await store.add({
      name: 'RO',
      driver: 'plugin',
      plugin: 'acme.fake',
      readOnly: true,
    });
    await manager.acquire('editor:a', { connectionId: readOnly.id });
    expect(plugin.opened[0]).toMatchObject({ readOnly: true });
  });

  it('closes the plugin session with the connection', async () => {
    await manager.acquire('editor:a', { connectionId: config.id });
    await manager.disconnect(config.id);
    expect(plugin.sessions[0]?.closed).toBe(1);
  });

  it('gives the driver of the connection, for its dialect', async () => {
    const driver = await manager.driverOf(config.id);
    expect(driver.id).toBe('plugin');
    expect(driver.dialect.quoteIdentifier('a')).toBe('"a"');
  });

  it('tests a connection that is not saved', async () => {
    await manager.test({
      name: 'probe',
      driver: 'plugin',
      plugin: 'acme.fake',
      host: 'h',
    });
    expect(plugin.sessions[0]?.executed).toEqual(['SELECT 1']);
    expect(plugin.sessions[0]?.closed).toBe(1);
    expect(store.list()).toHaveLength(1);
  });

  it('reports a plugin that is gone, with its id', async () => {
    plugins.get('acme.fake');
    const gone = new PluginDrivers();
    const orphan = new ConnectionManager({
      store,
      logger: new RecordingLogger(),
      drivers: {
        get: () => Promise.reject(new Error('unused')),
        getPlugin: (id) => Promise.resolve(gone.get(id)),
      },
    });
    await expect(orphan.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
      name: 'DbError',
      code: 'unsupported',
      message: expect.stringContaining('acme.fake') as string,
    });
    expect(orphan.getState(config.id).status).toBe('error');
  });

  it('reports a provider that knows no plugins', async () => {
    const plain = new ConnectionManager({
      store,
      logger: new RecordingLogger(),
      drivers: provider(false),
    });
    await expect(plain.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });

  it('shows what the plugin said when it cannot connect', async () => {
    plugin.failWith = Object.assign(new Error('no route to host'), { code: 'connection-failed' });
    await expect(manager.acquire('editor:a', { connectionId: config.id })).rejects.toMatchObject({
      code: 'connection-failed',
      message: 'no route to host',
    });
    expect(manager.getState(config.id)).toMatchObject({ status: 'error' });
  });
});
