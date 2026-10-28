import { describe, expect, it } from 'vitest';
import {
  connectionFormProtocol,
  connectionInputSchema,
  PASSWORD_MAX_LENGTH,
  passwordChangeSchema,
} from '../../../../src/shared/protocols/connection-form';

const save = connectionFormProtocol.host.requests.save;
const stateEvent = connectionFormProtocol.webview.events.state;

describe('connectionInputSchema', () => {
  it('accepts a network connection', () => {
    const value = {
      name: 'Local',
      driver: 'mysql',
      host: '127.0.0.1',
      port: 7306,
      user: 'root',
      database: 'app',
    };
    expect(connectionInputSchema.parse(value)).toEqual(value);
  });

  it('accepts a file connection', () => {
    expect(
      connectionInputSchema.parse({ name: 'db', driver: 'sqlite', file: '/tmp/a.db' }),
    ).toEqual({ name: 'db', driver: 'sqlite', file: '/tmp/a.db' });
  });

  it('accepts an empty name so the page can report the problem itself', () => {
    expect(connectionInputSchema.parse({ name: '', driver: 'mysql' })).toEqual({
      name: '',
      driver: 'mysql',
    });
  });

  it('rejects an unknown driver', () => {
    expect(() => connectionInputSchema.parse({ name: 'x', driver: 'oracle' })).toThrow('driver');
  });

  it('rejects a port outside 1..65535 and a non-integer port', () => {
    expect(() => connectionInputSchema.parse({ name: 'x', driver: 'mysql', port: 0 })).toThrow(
      'port',
    );
    expect(() => connectionInputSchema.parse({ name: 'x', driver: 'mysql', port: 70_000 })).toThrow(
      'port',
    );
    expect(() => connectionInputSchema.parse({ name: 'x', driver: 'mysql', port: 1.5 })).toThrow(
      'port',
    );
  });

  it('rejects unknown and injected fields', () => {
    expect(() =>
      connectionInputSchema.parse({ name: 'x', driver: 'mysql', password: 'leak' }),
    ).toThrow('unexpected field');
    expect(() =>
      connectionInputSchema.parse(JSON.parse('{"name":"x","driver":"mysql","__proto__":{"a":1}}')),
    ).toThrow();
  });
});

describe('passwordChangeSchema', () => {
  it('accepts keep, set and clear', () => {
    expect(passwordChangeSchema.parse({ kind: 'keep' })).toEqual({ kind: 'keep' });
    expect(passwordChangeSchema.parse({ kind: 'set', value: 'pw' })).toEqual({
      kind: 'set',
      value: 'pw',
    });
    expect(passwordChangeSchema.parse({ kind: 'clear' })).toEqual({ kind: 'clear' });
  });

  it('rejects an unknown kind and an over-long password', () => {
    expect(() => passwordChangeSchema.parse({ kind: 'steal' })).toThrow('kind');
    expect(() =>
      passwordChangeSchema.parse({ kind: 'set', value: 'x'.repeat(PASSWORD_MAX_LENGTH + 1) }),
    ).toThrow('at most');
  });
});

describe('save request', () => {
  it('accepts a full draft and returns the new id', () => {
    const params = {
      input: { name: 'Local', driver: 'mysql', host: 'h' },
      password: { kind: 'set', value: 'pw' },
    };
    expect(save.params.parse(params)).toEqual(params);
    expect(save.result.parse({ connectionId: 'abc' })).toEqual({ connectionId: 'abc' });
  });

  it('rejects a draft without a password decision', () => {
    expect(() => save.params.parse({ input: { name: 'x', driver: 'mysql' } })).toThrow('password');
  });
});

describe('SSH in the draft', () => {
  const save = connectionFormProtocol.host.requests.save;
  const input = {
    name: 'x',
    driver: 'mysql',
    host: 'db',
    ssh: { id: 'main', host: 'bastion', user: 'u', auth: 'key', keyFile: '/k' },
  };

  it('accepts a hop and its secret decisions', () => {
    const draft = {
      input,
      password: { kind: 'keep' },
      ssh: [
        { hopId: 'main', password: { kind: 'clear' }, passphrase: { kind: 'set', value: 'p' } },
      ],
    };
    expect(save.params.parse(draft)).toEqual(draft);
  });

  it('rejects unknown auth methods and stray hop fields', () => {
    expect(() =>
      save.params.parse({
        input: { ...input, ssh: { ...input.ssh, auth: 'kerberos' } },
        password: { kind: 'keep' },
      }),
    ).toThrow('auth');
    expect(() =>
      save.params.parse({
        input: { ...input, ssh: { ...input.ssh, password: 'secret' } },
        password: { kind: 'keep' },
      }),
    ).toThrow('unexpected field');
  });

  it('rejects an SSH secret decision without a hop id', () => {
    expect(() =>
      save.params.parse({
        input,
        password: { kind: 'keep' },
        ssh: [{ password: { kind: 'keep' }, passphrase: { kind: 'keep' } }],
      }),
    ).toThrow('hopId');
  });
});

describe('state event', () => {
  it('describes a saved connection without carrying its password', () => {
    const payload = {
      connectionId: 'c1',
      input: { name: 'Local', driver: 'mysql', host: 'h', port: 3306 },
      hasStoredPassword: true,
      storedSsh: [],
      drivers: [
        { id: 'mysql', defaultPort: 3306, file: false },
        { id: 'sqlite', file: true },
      ],
    };
    const parsed = stateEvent.parse(payload);
    expect(parsed).toEqual(payload);
    expect(JSON.stringify(parsed)).not.toContain('password"');
  });

  it('accepts a new connection without an id', () => {
    const parsed = stateEvent.parse({
      input: { name: '', driver: 'mysql' },
      hasStoredPassword: false,
      storedSsh: [],
      drivers: [],
    });
    expect(parsed.connectionId).toBeUndefined();
  });

  it('rejects a payload that smuggles a password field', () => {
    expect(() =>
      stateEvent.parse({
        input: { name: '', driver: 'mysql' },
        hasStoredPassword: false,
        storedSsh: [],
        drivers: [],
        password: 'secret',
      }),
    ).toThrow('unexpected field');
  });
});

describe('protocol shape', () => {
  it('lets the host answer only the form requests', () => {
    expect(Object.keys(connectionFormProtocol.host.requests).sort()).toEqual([
      'pickFile',
      'pickKeyFile',
      'save',
      'test',
    ]);
    expect(Object.keys(connectionFormProtocol.host.events).sort()).toEqual(['close', 'ready']);
  });

  it('gives the page no requests, only the state event', () => {
    expect(Object.keys(connectionFormProtocol.webview.requests)).toEqual([]);
    expect(Object.keys(connectionFormProtocol.webview.events)).toEqual(['state']);
  });
});
