import { describe, expect, it } from 'vitest';
import { API_VERSION } from '../../../src/api/types';
import { PluginDrivers } from '../../../src/drivers/plugin/plugin-drivers';
import { createDataNestApi } from '../../../src/vscode/plugin-api';
import { RecordingLogger } from '../../helpers/fakes';
import { FakePlugin } from '../../helpers/fake-plugin';

describe('the public API (V12.7)', () => {
  it('names its version', () => {
    expect(createDataNestApi(new PluginDrivers(), new RecordingLogger()).apiVersion).toBe(1);
    expect(API_VERSION).toBe(1);
  });

  it('registers a driver and lists it, then takes it back', () => {
    const plugins = new PluginDrivers();
    const api = createDataNestApi(plugins, new RecordingLogger());
    const registration = api.registerDriver(new FakePlugin());
    expect(api.registeredDrivers()).toEqual(['acme.fake']);
    expect(plugins.get('acme.fake').id).toBe('plugin');
    registration.dispose();
    expect(api.registeredDrivers()).toEqual([]);
  });

  it('refuses a bad or repeated driver with an error the plugin can read', () => {
    const api = createDataNestApi(new PluginDrivers(), new RecordingLogger());
    api.registerDriver(new FakePlugin());
    expect(() => api.registerDriver(new FakePlugin())).toThrow(/already registered/u);
    expect(() => api.registerDriver(null as never)).toThrow(/object/u);
    expect(() => api.registerDriver({} as never)).toThrow(/not valid/u);
  });

  it('writes registrations to the log', () => {
    const logger = new RecordingLogger();
    const api = createDataNestApi(new PluginDrivers(), logger);
    api.registerDriver(new FakePlugin()).dispose();
    const text = logger.entries.map((entry) => entry.message).join('\n');
    expect(text).toContain('Driver "acme.fake" registered');
    expect(text).toContain('Driver "acme.fake" taken back');
  });

  it('is frozen, so one plugin cannot swap it for the next', () => {
    const api = createDataNestApi(new PluginDrivers(), new RecordingLogger());
    expect(Object.isFrozen(api)).toBe(true);
    expect(() => {
      (api as { registerDriver: unknown }).registerDriver = () => undefined;
    }).toThrow();
  });
});
