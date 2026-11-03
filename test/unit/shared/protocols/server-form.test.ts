import { describe, expect, it } from 'vitest';
import { serverFormProtocol } from '../../../../src/shared/protocols/server-form';

const input = {
  name: 'Web',
  ssh: { id: 'main', host: 'web.example.com', user: 'deploy', auth: 'password' },
};

const draft = {
  input,
  ssh: [
    {
      hopId: 'main',
      password: { kind: 'set', value: 'pw' },
      passphrase: { kind: 'clear' },
    },
  ],
};

const { test, save, pickKeyFile } = serverFormProtocol.host.requests;
const { state } = serverFormProtocol.webview.events;

describe('the server form protocol', () => {
  it('takes a draft with the server and the change of every secret', () => {
    expect(save.params.parse(draft)).toMatchObject({ input: { name: 'Web' } });
    expect(test.params.parse({ ...draft, proxyPassword: { kind: 'keep' } })).toBeDefined();
  });

  it('refuses a draft the store would refuse', () => {
    expect(() => save.params.parse({ ...draft, input: { ...input, name: '' } })).toThrow();
    expect(() => save.params.parse({ ...draft, input: { name: 'x' } })).toThrow();
    expect(() => save.params.parse({ input })).toThrow();
    expect(() =>
      save.params.parse({ ...draft, ssh: [{ hopId: '', password: { kind: 'keep' } }] }),
    ).toThrow();
    expect(() =>
      save.params.parse({
        ...draft,
        ssh: [{ ...draft.ssh[0], password: { kind: 'wipe' } }],
      }),
    ).toThrow();
  });

  it('carries a password only as part of a draft, never in the state', () => {
    expect(state.parse({ storedSsh: [] })).toEqual({ storedSsh: [] });
    const parsed = state.parse({
      serverId: 'abc',
      input,
      storedSsh: [{ hopId: 'main', password: true, passphrase: false }],
      hasStoredProxyPassword: true,
    });
    expect(parsed.hasStoredProxyPassword).toBe(true);
    expect(() => state.parse({ input })).toThrow();
    expect(() => state.parse({ storedSsh: [{ hopId: 'main', password: 'pw' }] })).toThrow();
  });

  it('answers a test with the login folder and the number of servers on the way', () => {
    expect(test.result.parse({ home: '/home/deploy', hops: 2 })).toEqual({
      home: '/home/deploy',
      hops: 2,
    });
    expect(() => test.result.parse({ home: '/', hops: 0 })).toThrow();
    expect(() => test.result.parse({ home: '/', hops: 1.5 })).toThrow();
    expect(() => test.result.parse({ hops: 1 })).toThrow();
  });

  it('answers a save with the id, and a key dialog with a path or nothing', () => {
    expect(save.result.parse({ serverId: 'abc' })).toEqual({ serverId: 'abc' });
    expect(() => save.result.parse({})).toThrow();
    expect(pickKeyFile.result.parse({})).toEqual({});
    expect(pickKeyFile.result.parse({ file: '/home/me/.ssh/id' })).toEqual({
      file: '/home/me/.ssh/id',
    });
  });

  it('has the events a page needs to start and to close', () => {
    expect(serverFormProtocol.host.events.ready.parse({})).toEqual({});
    expect(serverFormProtocol.host.events.close.parse({})).toEqual({});
  });
});
