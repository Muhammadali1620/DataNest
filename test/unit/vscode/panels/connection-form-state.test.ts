import { describe, expect, it } from 'vitest';
import {
  driverOptions,
  NEW_CONNECTION,
  storedSshFlags,
  testSshSecrets,
  toInput,
  toPasswordChange,
  toSshChanges,
  testSentinelPassword,
  toSentinelChange,
} from '../../../../src/vscode/panels/connection-form-state';
import type { ConnectionDraft } from '../../../../src/shared/protocols/connection-form';
import { DRIVER_IDS, isFileDriver } from '../../../../src/shared/connection';
import { connectionFormProtocol } from '../../../../src/shared/protocols/connection-form';
import { connectionInputShape } from '../../../../src/shared/connection-schema';

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
        storedSsh: [],
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

  it('keeps the production and read-only flags, so saving the form does not drop them', () => {
    expect(
      toInput({
        id: 'c1',
        name: 'x',
        driver: 'mysql',
        host: 'h',
        production: true,
        readOnly: true,
      }),
    ).toMatchObject({ production: true, readOnly: true });
  });

  it('carries every field the form edits, so none is lost on save', () => {
    const full = {
      id: 'c1',
      name: 'Full',
      driver: 'postgres',
      host: 'db',
      port: 7432,
      user: 'app',
      database: 'shop',
      file: '/tmp/x.db',
      ssh: { id: 'main', host: 'b', user: 'u', auth: 'agent' },
      ssl: { mode: 'verify-full', ca: '/ca.pem' },
      folder: 'Work',
      color: 'red',
      production: true,
      readOnly: true,
      options: { keepAlive: 60, initSql: 'SET a = 1' },
      filter: { databases: ['shop'], schemas: ['public'] },
      redis: { mode: 'sentinel', masterName: 'm', nodes: [{ host: 's2' }], sentinelUser: 'u' },
      mongo: { mode: 'replicaSet', replicaSet: 'rs0', authMechanism: 'SCRAM-SHA-256' },
    } as const;
    const input = toInput(full);
    const sent = connectionFormProtocol.host.requests.save.params.parse({
      input,
      password: { kind: 'keep' },
    }).input;
    expect(sent).toEqual(input);
    // A field added to the form later must be listed above and travel too.
    expect(Object.keys(input).sort()).toEqual(Object.keys(connectionInputShape).sort());
  });

  it('leaves out fields that hold undefined', () => {
    expect(
      Object.keys(toInput({ id: 'c', name: 'n', driver: 'sqlite', file: 'a.db', host: undefined })),
    ).toEqual(['name', 'driver', 'file']);
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

describe('SSH secrets from the form', () => {
  const draft: ConnectionDraft = {
    input: {
      name: 'p',
      driver: 'mysql',
      host: 'db',
      ssh: { id: 'main', host: 'b', user: 'u', auth: 'password' },
    },
    password: { kind: 'keep' },
    ssh: [
      {
        hopId: 'main',
        password: { kind: 'set', value: 'typed' },
        passphrase: { kind: 'clear' },
      },
    ],
  };

  it('keeps the SSH settings when a config is put into the form', () => {
    const ssh = { id: 'main', host: 'b', user: 'u', auth: 'agent' as const };
    expect(toInput({ id: 'c', name: 'n', driver: 'mysql', host: 'h', ssh })).toMatchObject({ ssh });
  });

  it('maps the decisions per hop id', () => {
    expect(toSshChanges(draft)).toEqual({
      main: { password: { kind: 'set', value: 'typed' }, passphrase: { kind: 'clear' } },
    });
    expect(toSshChanges({ ...draft, ssh: undefined })).toEqual({});
    expect(
      toSshChanges({
        ...draft,
        ssh: [{ hopId: 'main', password: { kind: 'set' }, passphrase: { kind: 'keep' } }],
      }).main?.password,
    ).toEqual({ kind: 'set', value: '' });
  });

  it('tests with what was typed, else with what is stored', () => {
    expect(testSshSecrets(draft, { main: { password: 'old', passphrase: 'pp' } })).toEqual({
      main: { password: 'typed' },
    });
    expect(
      testSshSecrets({ ...draft, ssh: undefined }, { main: { password: 'old', passphrase: 'pp' } }),
    ).toEqual({ main: { password: 'old', passphrase: 'pp' } });
    expect(
      testSshSecrets(
        {
          ...draft,
          ssh: [
            { hopId: 'main', password: { kind: 'set', value: '' }, passphrase: { kind: 'keep' } },
          ],
        },
        {},
      ),
    ).toEqual({ main: {} });
  });

  it('ignores secrets of hops the draft does not have', () => {
    expect(
      testSshSecrets(
        { ...draft, input: { ...draft.input, ssh: undefined } },
        { main: { password: 'x' } },
      ),
    ).toEqual({});
  });

  it('tells the page only which secrets exist', () => {
    expect(storedSshFlags({ main: { password: 'x' }, other: { passphrase: 'y' } })).toEqual([
      { hopId: 'main', password: true, passphrase: false },
      { hopId: 'other', password: false, passphrase: true },
    ]);
  });
});

describe('toInput keeps every editable setting', () => {
  it('carries TLS, folder and color into the form, so saving does not drop them', () => {
    const config = {
      id: 'c',
      name: 'n',
      driver: 'postgres' as const,
      host: 'h',
      ssl: { mode: 'verify-full' as const, ca: '/ca' },
      folder: 'Prod',
      color: 'red' as const,
    };
    const input = toInput(config);
    expect(input).toEqual({
      name: 'n',
      driver: 'postgres',
      host: 'h',
      ssl: { mode: 'verify-full', ca: '/ca' },
      folder: 'Prod',
      color: 'red',
    });
    expect(() =>
      connectionFormProtocol.webview.events.state.parse({
        input,
        hasStoredPassword: false,
        storedSsh: [],
        drivers: driverOptions(),
      }),
    ).not.toThrow();
  });
});

describe('Sentinel password (V7.1)', () => {
  const draft = (sentinelPassword?: ConnectionDraft['sentinelPassword']): ConnectionDraft => ({
    input: { name: 'r', driver: 'redis', host: 'h', redis: { mode: 'sentinel', masterName: 'm' } },
    password: { kind: 'keep' },
    ...(sentinelPassword === undefined ? {} : { sentinelPassword }),
  });

  it('keeps the stored one when the form says nothing or keep', () => {
    expect(toSentinelChange(draft())).toEqual({ kind: 'keep' });
    expect(testSentinelPassword(draft(), 'stored')).toBe('stored');
    expect(testSentinelPassword(draft({ kind: 'keep' }), 'stored')).toBe('stored');
  });

  it('uses a typed one and forgets an erased one', () => {
    expect(toSentinelChange(draft({ kind: 'set', value: 'new' }))).toEqual({
      kind: 'set',
      value: 'new',
    });
    expect(testSentinelPassword(draft({ kind: 'set', value: 'new' }), 'stored')).toBe('new');
    expect(testSentinelPassword(draft({ kind: 'set', value: '' }), 'stored')).toBeUndefined();
    expect(toSentinelChange(draft({ kind: 'clear' }))).toEqual({ kind: 'clear' });
    expect(testSentinelPassword(draft({ kind: 'clear' }), 'stored')).toBeUndefined();
  });

  it('travels in the draft the page sends', () => {
    const parsed = connectionFormProtocol.host.requests.save.params.parse(
      draft({ kind: 'set', value: 'spw' }),
    );
    expect(parsed.sentinelPassword).toEqual({ kind: 'set', value: 'spw' });
  });
});
