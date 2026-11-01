import { describe, expect, it, vi } from 'vitest';
import type { PluginDriver } from '../../../../src/api/types';
import { PluginDrivers } from '../../../../src/drivers/plugin/plugin-drivers';
import { DriverRegistry } from '../../../../src/drivers/registry';
import { RecordingLogger } from '../../../helpers/fakes';
import { descriptor, FakePlugin } from '../../../helpers/fake-plugin';

describe('PluginDrivers', () => {
  it('registers a driver and finds it by id', () => {
    const plugins = new PluginDrivers();
    plugins.register(new FakePlugin());
    expect(plugins.get('acme.fake').id).toBe('plugin');
    expect(plugins.describe('acme.fake')).toEqual({
      id: 'acme.fake',
      label: 'Fake DB',
      fields: ['host', 'port', 'user', 'password', 'database', 'file'],
      defaultPort: 4000,
    });
    expect(plugins.list().map((info) => info.id)).toEqual(['acme.fake']);
  });

  it('refuses a driver that is not valid, naming the problem', () => {
    const plugins = new PluginDrivers();
    expect(() => plugins.register({ ...descriptor(), id: 'Not Valid' })).toThrow(
      expect.objectContaining({ name: 'DbError', code: 'unsupported' }) as Error,
    );
    expect(plugins.list()).toEqual([]);
  });

  it('refuses a second driver with the same id and keeps the first', () => {
    const plugins = new PluginDrivers();
    const first = new FakePlugin();
    plugins.register(first);
    expect(() => plugins.register(new FakePlugin())).toThrow(/already registered/u);
    expect(plugins.list()).toHaveLength(1);
  });

  it('tidies the fields: known ones only, once, in the order of the form', () => {
    const plugins = new PluginDrivers();
    plugins.register({
      ...descriptor(),
      id: 'acme.tidy',
      fields: ['file', 'host', 'nope', 'host', 'user'] as unknown as PluginDriver['fields'],
    });
    expect(plugins.describe('acme.tidy')?.fields).toEqual(['host', 'user', 'file']);
  });

  it('keeps a default port only when it is a port', () => {
    const plugins = new PluginDrivers();
    const make = (id: string, defaultPort: unknown): PluginDriver => ({
      id,
      label: 'L',
      fields: [],
      defaultPort: defaultPort as number,
      openSession: () => Promise.reject(new Error('unused')),
    });
    for (const [id, port] of [
      ['acme.a', 0],
      ['acme.b', 70_000],
      ['acme.c', 1.5],
      ['acme.d', '80'],
    ] as const) {
      plugins.register(make(id, port));
      expect(plugins.describe(id)).not.toHaveProperty('defaultPort');
    }
    plugins.register(make('acme.e', 5432));
    expect(plugins.describe('acme.e')?.defaultPort).toBe(5432);
  });

  it('trims the label', () => {
    const plugins = new PluginDrivers();
    plugins.register({ ...descriptor(), id: 'acme.t', label: '  Spaced  ' });
    expect(plugins.describe('acme.t')?.label).toBe('Spaced');
  });

  it('takes a driver back when its registration is disposed, once', () => {
    const plugins = new PluginDrivers();
    const registration = plugins.register(new FakePlugin());
    registration.dispose();
    registration.dispose();
    expect(plugins.list()).toEqual([]);
    expect(() => plugins.get('acme.fake')).toThrow(/not available/u);
    expect(plugins.describe('acme.fake')).toBeUndefined();
  });

  it('lets an old registration dispose nothing once the id was registered again', () => {
    const plugins = new PluginDrivers();
    const old = plugins.register(new FakePlugin());
    old.dispose();
    plugins.register(new FakePlugin());
    old.dispose();
    expect(plugins.list()).toHaveLength(1);
  });

  it('says which driver is missing', () => {
    expect(() => new PluginDrivers().get('acme.gone')).toThrow(
      expect.objectContaining({
        code: 'unsupported',
        message: expect.stringContaining('acme.gone') as string,
      }) as Error,
    );
  });

  it('tells the listeners about every change, and only until they leave', () => {
    const plugins = new PluginDrivers();
    const changed = vi.fn();
    const subscription = plugins.onDidChange(changed);
    const registration = plugins.register(new FakePlugin());
    registration.dispose();
    expect(changed).toHaveBeenCalledTimes(2);
    subscription.dispose();
    plugins.register(new FakePlugin());
    expect(changed).toHaveBeenCalledTimes(2);
  });

  it('does not notify for a refused registration', () => {
    const plugins = new PluginDrivers();
    const changed = vi.fn();
    plugins.onDidChange(changed);
    expect(() => plugins.register({ ...descriptor(), id: '' })).toThrow();
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('DriverRegistry.getPlugin', () => {
  const loader = () => Promise.reject(new Error('no bundles here'));

  it('gives the driver another extension registered', async () => {
    const plugins = new PluginDrivers();
    plugins.register(new FakePlugin());
    const registry = new DriverRegistry({ loader, logger: new RecordingLogger(), plugins });
    expect((await registry.getPlugin('acme.fake')).id).toBe('plugin');
  });

  it('fails clearly when the driver is not registered', async () => {
    const registry = new DriverRegistry({
      loader,
      logger: new RecordingLogger(),
      plugins: new PluginDrivers(),
    });
    await expect(registry.getPlugin('acme.gone')).rejects.toMatchObject({
      name: 'DbError',
      code: 'unsupported',
    });
  });

  it('fails clearly when the registry has no plugins at all', async () => {
    const registry = new DriverRegistry({ loader, logger: new RecordingLogger() });
    await expect(registry.getPlugin('acme.fake')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('never loads a bundle for the plugin kind', async () => {
    const registry = new DriverRegistry({ loader, logger: new RecordingLogger() });
    await expect(registry.get('plugin' as never)).rejects.toMatchObject({ code: 'unsupported' });
  });
});
