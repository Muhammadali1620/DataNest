import { describe, expect, it } from 'vitest';
import {
  driverOptions,
  NEW_CONNECTION,
  toInput,
  toPasswordChange,
} from '../../../../src/vscode/panels/connection-form-state';
import { DRIVER_IDS, isFileDriver } from '../../../../src/shared/connection';
import { connectionFormProtocol } from '../../../../src/shared/protocols/connection-form';

describe('NEW_CONNECTION', () => {
  it('starts on MySQL with its default port', () => {
    expect(NEW_CONNECTION).toEqual({
      name: '',
      driver: 'mysql',
      host: '127.0.0.1',
      port: 3306,
    });
  });

  it('is a valid payload for the state event', () => {
    expect(() =>
      connectionFormProtocol.webview.events.state.parse({
        input: NEW_CONNECTION,
        hasStoredPassword: false,
        drivers: driverOptions(),
      }),
    ).not.toThrow();
  });
});

describe('driverOptions', () => {
  it('offers every driver the extension ships', () => {
    expect(driverOptions().map((option) => option.id)).toEqual([...DRIVER_IDS]);
  });

  it('marks file drivers and gives network drivers a default port', () => {
    const byId = new Map(driverOptions().map((option) => [option.id, option]));
    expect(byId.get('mysql')).toEqual({ id: 'mysql', file: false, defaultPort: 3306 });
    expect(byId.get('postgres')).toEqual({ id: 'postgres', file: false, defaultPort: 5432 });
    expect(byId.get('sqlite')).toEqual({ id: 'sqlite', file: true });
  });

  it('agrees with the model about which drivers use a file', () => {
    for (const option of driverOptions()) {
      expect(option.file).toBe(isFileDriver(option.id));
    }
  });
});

describe('toInput', () => {
  it('drops the id and keeps every filled field', () => {
    expect(
      toInput({
        id: 'c1',
        name: 'Local',
        driver: 'mysql',
        host: 'db',
        port: 7306,
        user: 'root',
        database: 'app',
      }),
    ).toEqual({
      name: 'Local',
      driver: 'mysql',
      host: 'db',
      port: 7306,
      user: 'root',
      database: 'app',
    });
  });

  it('omits fields that are not set, so the schema accepts the result', () => {
    const input = toInput({ id: 'c1', name: 'db', driver: 'sqlite', file: '/tmp/a.db' });
    expect(input).toEqual({ name: 'db', driver: 'sqlite', file: '/tmp/a.db' });
    expect(() =>
      connectionFormProtocol.host.requests.save.params.parse({
        input,
        password: { kind: 'keep' },
      }),
    ).not.toThrow();
  });

  it('produces no id field that would be rejected as unexpected', () => {
    expect(toInput({ id: 'c1', name: 'x', driver: 'mysql', host: 'h' })).not.toHaveProperty('id');
  });
});

describe('toPasswordChange', () => {
  const input = { name: 'x', driver: 'mysql', host: 'h' } as const;

  it('keeps the stored password', () => {
    expect(toPasswordChange({ input, password: { kind: 'keep' } })).toEqual({ kind: 'keep' });
  });

  it('sets a new password', () => {
    expect(toPasswordChange({ input, password: { kind: 'set', value: 'pw' } })).toEqual({
      kind: 'set',
      value: 'pw',
    });
  });

  it('treats a set without a value as an empty one, which the store erases', () => {
    expect(toPasswordChange({ input, password: { kind: 'set' } })).toEqual({
      kind: 'set',
      value: '',
    });
  });

  it('clears the password', () => {
    expect(toPasswordChange({ input, password: { kind: 'clear' } })).toEqual({ kind: 'clear' });
  });
});
